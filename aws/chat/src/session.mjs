/**
 * @file session.mjs
 * Signed sessions, shared by sign-in (auth.mjs) and the chat service:
 *   b64url(json) + "." + hex(hmac_sha256(key, b64url(json)))
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import crypto from 'node:crypto';

/**
 * Encodes bytes or a string as base64url without padding.
 * @param {Buffer|string} buf - The data to encode.
 * @returns {string} The base64url text.
 */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/**
 * Decodes base64url text.
 * @param {string} s - The base64url text.
 * @returns {Buffer} The decoded bytes.
 */
const unb64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Signs an object as a session string.
 * @param {Object} obj - The session contents; `exp` (seconds) is what verify checks.
 * @param {string} key - The HMAC key.
 * @returns {string} The session string, `payload.mac`.
 */
export function sign(obj, key) {
  const payload = b64u(JSON.stringify(obj));
  return payload + '.' + crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Checks a session string's signature and expiry.
 * @param {string} value - The session string.
 * @param {string} key - The HMAC key.
 * @param {number} [now=Date.now()] - Current time in milliseconds.
 * @returns {?Object} The session contents, or null when it is malformed, wrongly signed or expired.
 */
export function verify(value, key, now = Date.now()) {
  if (typeof value !== 'string' || !key) return null;
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const payload = value.slice(0, i), mac = value.slice(i + 1);
  const good = crypto.createHmac('sha256', key).update(payload).digest('hex');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const obj = JSON.parse(unb64u(payload).toString('utf8'));
    return obj && obj.exp > now / 1000 ? obj : null;
  } catch { return null; }
}

/**
 * Finds the owner's session in a request: from a ticket, a Bearer header or a msgr_s cookie, in that order.
 * Only a session of kind `ws` is accepted as a ticket.
 * @param {Object} req - Where to look.
 * @param {Object} [req.headers] - Request headers.
 * @param {string[]} [req.cookies] - Request cookies.
 * @param {string} [req.ticket] - A WebSocket ticket.
 * @param {string} key - The HMAC key.
 * @param {string} allowedEmail - The owner's email; the session must belong to it.
 * @param {number} [now=Date.now()] - Current time in milliseconds.
 * @returns {?Object} The session, or null.
 */
export function ownerFrom({ headers = {}, cookies = [], ticket }, key, allowedEmail, now = Date.now()) {
  const ok = s => (s && allowedEmail && String(s.e || '').toLowerCase() === allowedEmail.toLowerCase() ? s : null);
  if (ticket) {
    const s = ok(verify(ticket, key, now));
    return s && s.k === 'ws' ? s : null;              // only a ws ticket opens a socket by ticket
  }
  const auth = headers.authorization || headers.Authorization || '';
  if (auth.startsWith('Bearer ')) return ok(verify(auth.slice(7).trim(), key, now));
  const jar = [...cookies, ...String(headers.cookie || '').split(';')];
  for (const c of jar) {
    const [k, ...v] = c.trim().split('=');
    if (k === 'msgr_s') return ok(verify(v.join('='), key, now));
  }
  return null;
}
