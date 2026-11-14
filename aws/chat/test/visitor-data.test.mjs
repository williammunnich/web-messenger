/**
 * @file visitor-data.test.mjs
 * Tests for the visitor's own-data endpoints.
 *   node --test aws/chat/test/visitor-data.test.mjs   a visitor sees and deletes their own data (POST /visitor/data, /visitor/forget)
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { route } from '../src/handler.mjs';
import { sign } from '../src/session.mjs';

/** The session key, the owner's address and the allowed site used in every test. */
const KEY = 'k'.repeat(64), OWNER = 'owner@example.com', SITE = 'https://example.com';
/** Two well-formed visitor ids. */
const VID = 'VisitorAAAA1111bbbb22', OTHER = 'VisitorBBBB3333cccc44';
/** Headers of a real phone browser on the allowed site. */
const UA = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', origin: SITE };
/** Per-test state: the fake clock (ms), the store, frames per socket, the service and its log events. */
let clock, store, sent, svc, logs;

/** Before each test: a fixed clock, a store with two remembered visitors, and a service that allows two sites. */
beforeEach(async () => {
  clock = Date.UTC(2026, 10, 11, 18); store = createMemoryStore(() => clock); sent = {}; logs = [];
  svc = createService({ store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: o => logs.push(o), ownerName: 'Pat Owner',
    allowedOrigins: [SITE, 'https://shop.example.org'], siteUrl: SITE, wsUrl: 'wss://chat.example.com',
    post: async (id, m) => { (sent[id] ||= []).push(m); return 'ok'; }, push: async () => ({ status: 200 }) });
  for (const vid of [VID, OTHER]) await store.put({ pk: 'VISITOR#' + vid, sk: 'META', visits: 2, devs: ['Phone · iOS · Safari'], exp: clock / 1000 + 86400 });
});

/**
 * Builds the parts `route` needs, with sign-in and pages that never answer.
 * @returns {{svc: Object, auth: Object, web: function}} The app.
 */
const app = () => ({ svc, auth: { handle: async () => null }, web: async () => null });
/**
 * Sends an HTTP API event through `route` as a browser on the allowed site would.
 * @param {string} method - HTTP method.
 * @param {string} path - Request path.
 * @param {Object} [body] - JSON body; undefined sends an empty body.
 * @param {Object} [headers] - Headers to add or override.
 * @param {string} [ip] - The caller's address.
 * @returns {Promise<Object>} The Lambda response.
 */
const call = (method, path, body, headers = {}, ip = '73.1.2.3') => route(app(), {
  rawPath: path, headers: { 'content-type': 'application/json', origin: SITE, ...headers }, body: body === undefined ? '' : JSON.stringify(body),
  requestContext: { domainName: 'api.example.com', http: { method, sourceIp: ip } } });
/**
 * Parses a response body.
 * @param {Object} r - The Lambda response.
 * @returns {Object} The JSON body (empty object for an empty body).
 */
const json = r => JSON.parse(r.body || '{}');

/**
 * Plays a visitor on the site: connects, says hello, writes a message; the owner answers.
 * @param {string} conn - Connection id.
 * @param {string} vid - Visitor id.
 * @param {string} text - The visitor's message.
 * @returns {Promise<void>}
 */
async function chat(conn, vid, text) {
  assert.equal(await svc.wsConnect({ connId: conn, query: { role: 'visitor', vid, sid: 'tab' + conn + 'xxxxxx', page: '/', persist: '1' }, headers: UA, ip: '73.1.2.3' }), 200);
  await svc.wsMessage(conn, JSON.stringify({ action: 'hello' }));
  clock += 3000;
  await svc.wsMessage(conn, JSON.stringify({ action: 'send', text, name: 'Sam', email: 'sam@example.com' }));
  const t = sign({ e: OWNER, k: 'app', exp: clock / 1000 + 3600 }, KEY);
  await svc.http({ method: 'POST', path: `/owner/conversations/${vid}/messages`, headers: { authorization: 'Bearer ' + t }, body: JSON.stringify({ text: 'Hi ' + vid.slice(0, 9) }) });
}
/**
 * Opens an owner socket with a ticket.
 * @param {string} conn - Connection id.
 * @returns {Promise<void>}
 */
async function ownerSocket(conn) {
  const t = sign({ e: OWNER, k: 'app', exp: clock / 1000 + 3600 }, KEY);
  const ticket = (await svc.http({ method: 'POST', path: '/owner/ticket', headers: { authorization: 'Bearer ' + t } })).body.ticket;
  assert.equal(await svc.wsConnect({ connId: conn, query: { role: 'owner', ticket } }), 200);
}
/**
 * Lists every stored row tied to a visitor.
 * @param {string} vid - Visitor id.
 * @returns {Object[]} The rows.
 */
const rowsFor = vid => [...store.rows.values()].filter(r => r.pk.includes(vid) || r.vid === vid);

test('data: the visitor gets their conversation, messages and profile, readable by a person', async () => {
  await chat('v1', VID, 'Hello there');
  const r = await call('POST', '/visitor/data', { vid: VID });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], SITE);
  const d = json(r);
  assert.equal(d.vid, VID);
  assert.deepEqual(d.messages.map(m => [m.from, m.text]), [['visitor', 'Hello there'], ['owner', 'Hi VisitorAA']]);
  assert.equal(typeof d.messages[0].at, 'number');
  assert.equal(d.owner, 'Pat Owner');
  assert.equal(d.conversation.email, 'sam@example.com');
  assert.equal(d.conversation.name, 'Sam');
  assert.equal(d.visitor.visits >= 2, true);
  assert.equal(d.openChatWindows, 1);
  assert.ok(d.notListed);
});

test('forget: deletes every row tied to the visitor, tells the owner, and leaves other visitors alone', async () => {
  await ownerSocket('o1');
  await chat('v1', VID, 'Please forget me');
  await chat('v2', OTHER, 'Keep me');
  await svc.wsMessage('v1', JSON.stringify({ action: 'hello' }));          // a second hello: THR#seen row exists
  const otherBefore = rowsFor(OTHER).length;
  assert.ok(rowsFor(VID).length > 3);

  const r = await call('POST', '/visitor/forget', { vid: VID });
  assert.equal(r.statusCode, 200);
  assert.ok(json(r).deleted > 3);
  const left = rowsFor(VID).filter(x => !x.pk.startsWith('DUP#') && !x.pk.startsWith('RATE#'));
  assert.deepEqual(left, [], 'nothing left but expiring spam counters');
  assert.equal(await store.get('CONV#' + VID, 'META'), null);
  assert.equal(await store.get('VISITOR#' + VID, 'META'), null);
  assert.equal(await store.get('CONN#v1', 'META'), null);
  assert.equal(rowsFor(OTHER).length, otherBefore, 'the other visitor is untouched');
  assert.ok(await store.get('CONV#' + OTHER, 'META'));
  assert.ok(sent.o1.some(f => f.type === 'forgotten' && f.vid === VID), 'the inbox drops it');
  assert.ok(!JSON.stringify(logs.filter(l => l.event === 'visitor_forgotten')).includes(VID), 'the log does not keep the id');

  const d = json(await call('POST', '/visitor/data', { vid: VID }));
  assert.deepEqual([d.conversation, d.messages, d.visitor], [null, [], null]);
  const owner = await svc.http({ method: 'GET', path: '/owner/conversations', headers: { authorization: 'Bearer ' + sign({ e: OWNER, k: 'app', exp: clock / 1000 + 3600 }, KEY) } });
  assert.deepEqual(owner.body.conversations.map(c => c.vid), [OTHER]);
});

test('CORS: only ALLOWED_ORIGINS, preflight answered, other sites refused without CORS headers', async () => {
  const pre = await call('OPTIONS', '/visitor/forget', undefined, { origin: 'https://shop.example.org' });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://shop.example.org');
  assert.match(pre.headers['access-control-allow-methods'], /POST/);
  await chat('v1', VID, 'Hello there');
  const bad = await call('POST', '/visitor/forget', { vid: VID }, { origin: 'https://evil.example' });
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  assert.ok(await store.get('CONV#' + VID, 'META'), 'nothing deleted');
  const preBad = await call('OPTIONS', '/visitor/data', undefined, { origin: 'https://evil.example' });
  assert.equal(preBad.statusCode, 403);
});

test('bad requests: no or malformed vid, not JSON, wrong method, vid in the address ignored', async () => {
  assert.equal((await call('POST', '/visitor/forget', {})).statusCode, 400);
  assert.equal((await call('POST', '/visitor/forget', { vid: '../../x' })).statusCode, 400);
  assert.equal((await call('POST', '/visitor/data', { vid: 'short' })).statusCode, 400);
  assert.equal((await call('POST', '/visitor/data', { vid: VID }, { 'content-type': 'text/plain' })).statusCode, 415);
  assert.equal((await call('GET', '/visitor/data')).statusCode, 405);
  const r = await route(app(), { rawPath: '/visitor/data', queryStringParameters: { vid: VID }, headers: { 'content-type': 'application/json', origin: SITE },
    body: '{', requestContext: { http: { method: 'POST', sourceIp: '1.1.1.1' } } });
  assert.equal(r.statusCode, 400);
});

test('rate limit: 30 requests an hour per network address', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await call('POST', '/visitor/data', { vid: VID }, {}, '9.9.9.9')).statusCode, 200);
  assert.equal((await call('POST', '/visitor/data', { vid: VID }, {}, '9.9.9.9')).statusCode, 429);
  assert.equal((await call('POST', '/visitor/data', { vid: VID }, {}, '9.9.9.8')).statusCode, 200, 'another address is fine');
  clock += 3600 * 1000;
  assert.equal((await call('POST', '/visitor/data', { vid: VID }, {}, '9.9.9.9')).statusCode, 200, 'next hour');
});

test('forget is safe to repeat and on an unknown visitor', async () => {
  const r1 = await call('POST', '/visitor/forget', { vid: 'NeverSeenVisitor00000' });
  assert.equal(r1.statusCode, 200);
  assert.equal(json(r1).deleted, 0);
  await chat('v1', VID, 'Hi');
  assert.ok(json(await call('POST', '/visitor/forget', { vid: VID })).deleted > 0);
  assert.equal(json(await call('POST', '/visitor/forget', { vid: VID })).deleted, 0);
});
