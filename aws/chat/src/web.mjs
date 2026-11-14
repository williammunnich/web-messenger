/**
 * @file web.mjs
 * The pages the Lambda serves itself: the owner's inbox at /, the widget at /widget/*, and a demo page at /demo.
 * No S3 or CloudFront needed, so one stack is the whole messenger.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder that holds the static files (`public`, next to this file). */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
/**
 * Reads a file from the public folder.
 * @param {string} f - File name inside `public`.
 * @param {string} [enc] - Text encoding; a Buffer is returned without one.
 * @returns {string|Buffer} The file's contents.
 */
const read = (f, enc) => fs.readFileSync(path.join(DIR, f), enc);

/**
 * Creates the handler that serves the inbox, the demo page and the widget files.
 * @param {Object} deps - What the pages need.
 * @param {{signedIn: function(Object): Promise<boolean>}} deps.auth - Sign-in check from auth.mjs.
 * @param {string} deps.wsUrl - The WebSocket address, allowed in the page's CSP and given to the widget.
 * @param {string} [deps.ownerName=''] - The owner's display name, given to the widget as a default.
 * @returns {function(Object): Promise<?Object>} The `web(request)` handler.
 */
export function createWeb({ auth, wsUrl, ownerName = '' }) {
  /** The WebSocket origin for the CSP's connect-src (the raw wsUrl when it does not parse). */
  const wsHost = (() => { try { return new URL(wsUrl).origin.replace(/^http/, 'ws'); } catch { return wsUrl; } })();
  /** Security headers added to every response. */
  const secure = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
  /**
   * Builds an HTML page response that is never cached.
   * @param {string} file - File name inside `public`.
   * @param {string} csp - The Content-Security-Policy to send.
   * @returns {{status: number, headers: Object, body: string}} The response.
   */
  const page = (file, csp) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp, ...secure }, body: read(file, 'utf8') });
  /**
   * Builds a widget file response: cached for five minutes and readable from any site.
   * @param {string} body - The file's contents.
   * @param {string} type - The content type.
   * @returns {{status: number, headers: Object, body: string}} The response.
   */
  const asset = (body, type) => ({ status: 200, headers: { 'content-type': type, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', ...secure }, body });
  /** The Content-Security-Policy for the inbox and demo pages. */
  const csp = `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsHost}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

  /**
   * Serves /, /demo, /widget/chat.js and /widget/chat.css (GET and HEAD only). The inbox redirects to /login
   * when the owner is not signed in, and chat.js is prefixed with a line that sets window.WM_CHAT_DEFAULTS.
   * @param {Object} req - The request.
   * @param {string} req.method - HTTP method.
   * @param {string} req.path - Request path.
   * @param {Object} [req.headers] - Request headers.
   * @param {string[]} [req.cookies] - Request cookies.
   * @returns {Promise<?Object>} A response for page paths, or null for everything else.
   */
  return async function web({ method, path: p, headers = {}, cookies = [] }) {
    if (method !== 'GET' && method !== 'HEAD') return null;
    if (p === '/') {
      if (!(await auth.signedIn({ headers, cookies }))) return { status: 302, headers: { location: '/login' }, body: '' };
      return page('inbox.html', csp);
    }
    if (p === '/demo') return page('demo.html', csp);
    if (p === '/widget/chat.js') {
      const defaults = `window.WM_CHAT_DEFAULTS=${JSON.stringify({ ws: wsUrl, ownerName })};\n`;
      return asset(defaults + read('chat.js', 'utf8'), 'text/javascript; charset=utf-8');
    }
    if (p === '/widget/chat.css') return asset(read('chat.css', 'utf8'), 'text/css; charset=utf-8');
    return null;
  };
}
