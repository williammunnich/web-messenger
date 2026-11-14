/**
 * @file apns.mjs
 * Apple Push Notification service client for the chat Lambda: token auth (.p8 key), over HTTP/2 with
 * Node's built-in http2. No packages. The service uses it to ring the owner's iPhone.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */
import crypto from 'node:crypto';
import http2 from 'node:http2';

/** APNs base address for each environment (`sandbox` or `production`). */
const HOSTS = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };
/**
 * Encodes bytes or a string as base64url without padding.
 * @param {Buffer|string} b - The data to encode.
 * @returns {string} The base64url text.
 */
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Builds the ES256 provider token (JWT) that authenticates requests to APNs.
 * @param {{keyPem: string, keyId: string, teamId: string}} creds - The .p8 key in PEM form, its key id and the Apple team id.
 * @param {number} [now=Date.now()] - Current time in milliseconds, used for the issued-at claim.
 * @returns {string} The signed token, `header.claims.signature`.
 */
export function apnsJwt({ keyPem, keyId, teamId }, now = Date.now()) {
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const body = b64u(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: keyPem, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/**
 * Creates a push sender that caches the provider token and one HTTP/2 session per APNs environment.
 * A result with status 410 or reason BadDeviceToken means "forget this device" (see deviceIsGone).
 * @param {function(): Promise<{keyPem: string, keyId: string, teamId: string}>} getCreds - Loads the APNs credentials when a new token is needed.
 * @returns {function(Object, Object, Object=): Promise<{status: number, reason: string}>} The `send(device, payload, opts)` function.
 */
export function createApns(getCreds) {
  let jwt = null, jwtAt = 0;
  const sessions = {};
  /**
   * Returns the cached provider token, making a new one when it is older than 45 minutes.
   * @returns {Promise<string>} The provider token.
   */
  async function token() {
    if (!jwt || Date.now() - jwtAt > 45 * 60 * 1000) { jwt = apnsJwt(await getCreds()); jwtAt = Date.now(); }  // Apple: refresh 20-60 min
    return jwt;
  }
  /**
   * Returns the open HTTP/2 session for an environment, connecting when there is none or it has closed.
   * @param {string} env - `sandbox` or `production`.
   * @returns {import('node:http2').ClientHttp2Session} The session to send requests on.
   */
  function session(env) {
    const s = sessions[env];
    if (s && !s.closed && !s.destroyed) return s;
    const n = http2.connect(HOSTS[env]);
    n.on('error', () => {}); n.on('goaway', () => n.close());
    n.setTimeout(60000, () => n.close());
    return (sessions[env] = n);
  }
  /**
   * Sends one notification to one device. Never rejects: connection errors and timeouts come back as status 0.
   * @param {{token: string, env: string}} device - The device token and its APNs environment (anything but `production` means sandbox).
   * @param {Object} payload - The APNs JSON payload.
   * @param {Object} [opts] - Delivery options.
   * @param {string} opts.topic - The app's bundle id (apns-topic).
   * @param {string} [opts.pushType='alert'] - The apns-push-type header.
   * @param {number} [opts.priority=10] - The apns-priority header.
   * @param {string} [opts.collapseId] - The apns-collapse-id header, when later pushes should replace earlier ones.
   * @returns {Promise<{status: number, reason: string}>} The HTTP status (0 on a transport failure) and APNs' reason text, if any.
   */
  return async function send(device, payload, { topic, pushType = 'alert', priority = 10, collapseId } = {}) {
    const env = device.env === 'production' ? 'production' : 'sandbox';
    const bearer = await token();
    return new Promise(resolve => {
      const headers = {
        ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${bearer}`,
        'apns-topic': topic, 'apns-push-type': pushType, 'apns-priority': String(priority),
      };
      if (collapseId) headers['apns-collapse-id'] = collapseId;
      let req;
      try { req = session(env).request(headers); } catch (e) { resolve({ status: 0, reason: String(e.message) }); return; }
      let status = 0, data = '';
      req.setEncoding('utf8');
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => { data += c; });
      req.on('end', () => { let reason = ''; try { reason = JSON.parse(data).reason || ''; } catch {} resolve({ status, reason }); });
      req.on('error', e => resolve({ status: 0, reason: String(e.message) }));
      req.setTimeout(8000, () => { req.close(); resolve({ status: 0, reason: 'timeout' }); });
      req.end(JSON.stringify(payload));
    });
  };
}

/**
 * Tells whether a send result means the device token is no longer valid and should be removed.
 * @param {{status: number, reason: string}} r - A result from the sender.
 * @returns {boolean} True for 410, or 400 with BadDeviceToken or DeviceTokenNotForTopic.
 */
export const deviceIsGone = r => r.status === 410 || (r.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(r.reason));
