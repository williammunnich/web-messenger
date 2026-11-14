/**
 * @file auth.mjs
 * Google sign-in for the one owner: the web inbox gets a msgr_s cookie, the iPhone app gets a token at
 * webmessenger://auth?token=…&state=… (docs/chat-protocol.md). Sessions are the signed format in session.mjs.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import crypto from 'node:crypto';
import { sign, verify, ownerFrom } from './session.mjs';

/** Lifetimes: web session in hours, app token in days, and the sign-in state cookie in seconds. */
const WEB_HOURS = 12, APP_DAYS = 90, STATE_S = 600;
/** The shape the app's `state` value must have before it is accepted at /app/login. */
const APP_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
/**
 * Makes a random base64url string.
 * @param {number} n - Number of random bytes.
 * @returns {string} The random text.
 */
const rnd = n => crypto.randomBytes(n).toString('base64url');
/**
 * Formats a Set-Cookie value that is Secure, HttpOnly and SameSite=Lax.
 * @param {string} name - Cookie name.
 * @param {string} value - Cookie value.
 * @param {number} age - Max-Age in seconds (0 clears the cookie).
 * @returns {string} The cookie string.
 */
const cookie = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
/**
 * Builds a plain-text response.
 * @param {number} status - HTTP status code.
 * @param {string} body - The text to show.
 * @param {string[]} [cookies=[]] - Cookies to set.
 * @returns {{status: number, cookies: string[], headers: Object, body: string}} The response.
 */
const text = (status, body, cookies = []) => ({ status, cookies, headers: { 'content-type': 'text/plain; charset=utf-8' }, body });
/**
 * Builds a 302 redirect response.
 * @param {string} location - Where to send the browser.
 * @param {string[]} [cookies=[]] - Cookies to set.
 * @returns {{status: number, cookies: string[], headers: Object, body: string}} The response.
 */
const redirect = (location, cookies = []) => ({ status: 302, cookies, headers: { location }, body: '' });

/**
 * Creates the sign-in handler for the Lambda's HTTP routes.
 * @param {Object} deps - What sign-in needs from outside.
 * @param {function(): Promise<string>} deps.sessionKey - Loads the key that signs sessions.
 * @param {string} deps.clientId - Google OAuth client id; sign-in answers 503 when it is empty.
 * @param {function(): Promise<string>} deps.clientSecret - Loads the Google OAuth client secret.
 * @param {string} deps.allowedEmail - The only Google account that may sign in.
 * @param {function(Object): void} [deps.log] - Receives sign-in events for logging.
 * @param {function} [deps.fetch] - The fetch function to use (tests replace it).
 * @param {function(): number} [deps.now] - Clock in milliseconds (tests replace it).
 * @returns {{handle: function(Object): Promise<?Object>, signedIn: function(Object): Promise<boolean>}} The route handler and a signed-in check.
 */
export function createAuth(deps) {
  const { sessionKey, clientId, clientSecret, allowedEmail, log = () => {}, fetch: doFetch = globalThis.fetch, now = () => Date.now() } = deps;
  /**
   * Current time in whole seconds.
   * @returns {number} Seconds since the epoch.
   */
  const sec = () => Math.floor(now() / 1000);
  /**
   * The OAuth callback address for this host.
   * @param {string} host - The host the request came in on.
   * @returns {string} The redirect URI registered with Google.
   */
  const redirectUri = host => `https://${host}/oauth2/callback`;

  /**
   * Starts sign-in: stores state, nonce and the PKCE verifier in a signed msgr_o cookie and redirects to Google.
   * @param {Object} args - Request details.
   * @param {string} args.host - The host the request came in on.
   * @param {string} [args.appState] - The iPhone app's state value, when the app started the sign-in.
   * @returns {Promise<Object>} A redirect to Google, or a 503 text response when Google sign-in is not set up.
   */
  async function login({ host, appState }) {
    if (!clientId) return text(503, 'Google sign-in is not set up: deploy with GOOGLE_CLIENT_ID (docs/deploy.md).');
    const verifier = rnd(48);
    const st = { state: rnd(24), nonce: rnd(24), v: verifier, exp: sec() + STATE_S, ...(appState ? { app: appState } : {}) };
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(host), response_type: 'code', scope: 'openid email',
      state: st.state, nonce: st.nonce, prompt: 'select_account', code_challenge_method: 'S256',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, [cookie('msgr_o', sign(st, await sessionKey()), STATE_S)]);
  }

  /**
   * Finishes sign-in: checks the state cookie, exchanges the code with Google, checks the ID token claims and
   * the allowed email, then issues a web session cookie or redirects the app to webmessenger://auth with a token.
   * @param {Object} args - Request details.
   * @param {string} args.host - The host the request came in on.
   * @param {Object} args.query - Query parameters (`code`, `state`).
   * @param {string[]} args.cookies - The request's cookies.
   * @param {string} args.ip - The caller's address, for the log.
   * @returns {Promise<Object>} A redirect on success, or a 400, 502 or 403 text response.
   */
  async function callback({ host, query, cookies, ip }) {
    const key = await sessionKey();
    const raw = cookies.map(c => c.trim()).find(c => c.startsWith('msgr_o='))?.slice('msgr_o='.length);   // the value after the cookie's name
    const st = verify(raw, key, now());
    const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (!st || !query.code || !same(String(query.state || ''), String(st.state || ''))) {
      log({ event: 'login_failed', reason: 'bad or expired state', ip });
      return text(400, 'Sign-in expired or invalid. Go to / to try again.');
    }
    let claims;
    try {
      const r = await doFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: query.code, client_id: clientId, client_secret: await clientSecret(), redirect_uri: redirectUri(host),
          grant_type: 'authorization_code', code_verifier: st.v }) });
      const tok = await r.json();
      // The ID token came straight from Google's token endpoint over TLS, so its signature check can rely on
      // that channel (OpenID Connect Core 3.1.3.7); the claims are still checked below.
      claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
    } catch (e) {
      log({ event: 'login_failed', reason: 'token exchange: ' + String(e.message || e).slice(0, 200), ip });
      return text(502, 'Could not complete sign-in with Google.');
    }
    const email = String(claims.email || '').toLowerCase();
    const ok = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) && claims.aud === clientId && claims.exp > sec()
      && claims.nonce === st.nonce && (claims.email_verified === true || claims.email_verified === 'true') && allowedEmail && email === allowedEmail.toLowerCase();
    const clear = cookie('msgr_o', '', 0);
    if (!ok) { log({ event: 'login_refused', email, ip }); return text(403, 'This Google account is not allowed here.', [clear]); }
    log({ event: 'login_ok', email, ip, app: !!st.app });
    if (st.app) {
      const token = sign({ e: email, k: 'app', exp: sec() + APP_DAYS * 86400 }, key);
      return redirect('webmessenger://auth?' + new URLSearchParams({ token, state: st.app }), [clear]);
    }
    return redirect('/', [cookie('msgr_s', sign({ e: email, k: 'web', exp: sec() + WEB_HOURS * 3600 }, key), WEB_HOURS * 3600), clear]);
  }

  /**
   * Routes the sign-in paths: /login, /app/login, /oauth2/callback and /logout (GET only).
   * @param {Object} req - The request.
   * @param {string} req.method - HTTP method.
   * @param {string} req.path - Request path.
   * @param {string} req.host - The host the request came in on.
   * @param {Object} [req.query] - Query parameters.
   * @param {Object} [req.headers] - Request headers.
   * @param {string[]} [req.cookies] - Request cookies.
   * @param {string} [req.ip] - The caller's address.
   * @returns {Promise<?Object>} A response for sign-in paths, or null for everything else.
   */
  async function handle({ method, path, host, query = {}, headers = {}, cookies = [], ip = '' }) {
    if (method !== 'GET') return null;
    const jar = [...cookies, ...String(headers.cookie || '').split(';')];
    if (path === '/login') return login({ host });
    if (path === '/app/login') {
      if (!APP_STATE_RE.test(query.state || '')) return text(400, 'Missing or bad state.');
      return login({ host, appState: query.state });
    }
    if (path === '/oauth2/callback') return callback({ host, query, cookies: jar, ip });
    if (path === '/logout') return redirect('/login', [cookie('msgr_s', '', 0)]);
    return null;
  }
  /**
   * Tells whether a request carries a valid owner session.
   * @param {Object} req - The request.
   * @param {Object} [req.headers] - Request headers.
   * @param {string[]} [req.cookies] - Request cookies.
   * @returns {Promise<boolean>} True when the owner is signed in.
   */
  const signedIn = async ({ headers = {}, cookies = [] }) => !!ownerFrom({ headers, cookies }, await sessionKey(), allowedEmail, now());
  return { handle, signedIn };
}
