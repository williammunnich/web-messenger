/**
 * @file smoke.mjs
 * End-to-end check over real sockets: a visitor writes, the owner sees it and replies, the visitor gets the reply.
 *   npm run smoke                                    starts its own bench and tests that
 *   SMOKE_BASE=http://localhost:8790 npm run smoke   a bench you started (e.g. npm run dev:dynamo)
 *   SMOKE_BASE=https://<InboxUrl> SMOKE_TOKEN=<session> SMOKE_ORIGIN=https://<allowed site> npm run smoke
 *     a deployed stack. Get a session from the wm_s cookie after signing in to the inbox. It leaves one test conversation.
 * Exits 0 when every step passes and 1 on the first failure.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

/** A browser-like user agent, because the service refuses bot-like ones. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
/** The port for the bench this script starts itself. */
const PORT = 8799;
let base = process.env.SMOKE_BASE?.replace(/\/$/, ''), bench;
if (!base) {
  bench = spawn(process.execPath, ['tools/chat-dev.mjs'], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, no) => { bench.stdout.once('data', ok); bench.once('exit', () => no(new Error('bench did not start'))); });
  base = `http://localhost:${PORT}`;
}
/** The owner's Authorization header when SMOKE_TOKEN is set (the local bench needs none). */
const auth = process.env.SMOKE_TOKEN ? { authorization: 'Bearer ' + process.env.SMOKE_TOKEN } : {};
/**
 * Calls the HTTP API with JSON and expects 200.
 * @param {string} method - HTTP method.
 * @param {string} path - Path under the base address.
 * @param {Object} [body] - JSON body.
 * @returns {Promise<Object>} The JSON answer.
 * @throws {Error} When the status is not 200.
 */
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(r.status, 200, `${method} ${path} gave ${r.status}`);
  return r.json();
};
/**
 * Opens a WebSocket and collects its frames.
 * @param {string} url - The socket address with its query.
 * @param {Object} headers - Headers for the handshake.
 * @returns {{ws: WebSocket, next: function, ready: Promise, send: function}} The socket, `next(test, what)` to wait for a frame, `ready` that resolves when open, and `send(frame)`.
 */
function open(url, headers) {
  const ws = new WebSocket(url, { headers }), frames = [], waiters = [];
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); frames.push(m); waiters.splice(0).forEach(w => w()); });
  /**
   * Waits up to 8 seconds for a frame that passes the test (frames already received count).
   * @param {function(Object): boolean} test - Picks the frame.
   * @param {string} what - Name of the frame for the timeout message.
   * @returns {Promise<Object>} The frame.
   * @throws {Error} On timeout.
   */
  const next = async (test, what) => {
    const end = Date.now() + 8000;
    for (;;) {
      const hit = frames.find(test);
      if (hit) return hit;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what);
      await new Promise(ok => { waiters.push(ok); setTimeout(ok, 250); });
    }
  };
  const ready = new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('socket refused: ' + url.split('?')[0]))); });
  return { ws, next, ready, send: f => ws.send(JSON.stringify(f)) };
}
/**
 * Prints a passed step.
 * @param {string} t - What passed.
 * @returns {void}
 */
const step = t => console.log('ok  ' + t);

let code = 0;
try {
  const js = await (await fetch(base + '/widget/chat.js')).text();
  const wsUrl = JSON.parse(js.slice(js.indexOf('{'), js.indexOf('}') + 1)).ws;
  assert.ok(wsUrl, 'widget has a socket address');
  step(`widget served, socket is ${wsUrl}`);

  const t = await api('POST', '/owner/ticket');
  const owner = open(`${t.ws}?role=owner&ticket=${encodeURIComponent(t.ticket)}`, { 'user-agent': UA });
  await owner.ready;
  step('owner socket open with a ticket');

  const vid = 'smoke' + crypto.randomBytes(9).toString('hex');
  const visitor = open(`${wsUrl}?role=visitor&vid=${vid}&page=/smoke&persist=1&me=1`, { 'user-agent': UA, origin: process.env.SMOKE_ORIGIN || base });
  await visitor.ready;
  visitor.send({ action: 'hello' });
  await visitor.next(m => m.type === 'hello', 'hello');
  step('visitor socket open, hello answered');

  await new Promise(ok => setTimeout(ok, 1700));              // the service refuses a first message sooner than a person could type
  const text = 'smoke test ' + vid;
  visitor.send({ action: 'send', text, name: 'Smoke Test' });
  await visitor.next(m => m.type === 'message' && m.message.text === text, 'the echo');
  await owner.next(m => m.type === 'message' && m.vid === vid, 'the owner frame');
  step('message reached the owner live');

  const { conversations } = await api('GET', '/owner/conversations?limit=50');
  assert.ok(conversations.some(c => c.vid === vid && c.unread === 1), 'listed with one unread');
  const { messages } = await api('GET', `/owner/conversations/${vid}/messages`);
  assert.equal(messages.at(-1).text, text);
  step('conversation and history stored');

  await api('POST', `/owner/conversations/${vid}/messages`, { text: 'smoke reply' });
  await visitor.next(m => m.type === 'message' && m.message.from === 'owner', 'the reply');
  step('reply reached the visitor');

  await api('POST', `/owner/conversations/${vid}/read`);
  await visitor.next(m => m.type === 'read', 'the read receipt');
  step('read receipt delivered');
  await api('POST', `/owner/conversations/${vid}/block`, { blocked: true });
  visitor.ws.close(); owner.ws.close();
  console.log('\nsmoke test passed against ' + base);
} catch (e) { console.error('\nFAILED: ' + e.message); code = 1; }
bench?.removeAllListeners('exit'); bench?.kill();
process.exit(code);
