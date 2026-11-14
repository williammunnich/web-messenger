/**
 * @file standalone.test.mjs
 * Tests for the parts around the chat service.
 *   node --test aws/chat/test/standalone.test.mjs   sign-in, visits, the Lambda event mapping, pages and the template.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createService, deviceFrom } from '../src/service.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { createAuth } from '../src/auth.mjs';
import { createWeb } from '../src/web.mjs';
import { route } from '../src/handler.mjs';
import { sign, verify } from '../src/session.mjs';
import { TABLE_SCHEMA } from '../../../tools/dynamo-local.mjs';

/** The session key, the owner's address, a visitor id and the API host used in every test. */
const KEY = 'k'.repeat(64), OWNER = 'owner@example.com', VID = 'VisitorAAAA1111bbbb22', HOST = 'api.example.com';
/** Headers of a real phone browser on the allowed site. */
const UA = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', origin: 'https://example.com' };
/** Per-test state: the fake clock (ms), the store, pushes, frames per socket, the service, sign-in, the page handler, and the function that makes Google's claims. */
let clock, store, pushes, sent, svc, auth, web, google;

/**
 * Builds an unsigned ID token around some claims, as the fake Google returns it.
 * @param {Object} claims - The token's claims.
 * @returns {string} The token.
 */
const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
/** Before each test: a fixed clock, an empty store, and the service, sign-in (with a fake Google token endpoint) and pages wired together. */
beforeEach(() => {
  clock = Date.UTC(2026, 9, 31, 18); store = createMemoryStore(() => clock); pushes = []; sent = {}; google = null;
  svc = createService({ store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: () => {}, wsUrl: 'wss://chat.example.com', siteUrl: 'https://example.com',
    post: async (id, m) => { (sent[id] ||= []).push(m); return 'ok'; }, push: async (d, p) => { pushes.push(p); return { status: 200 }; } });
  auth = createAuth({ sessionKey: async () => KEY, clientId: 'cid', clientSecret: async () => 'shh', allowedEmail: OWNER, now: () => clock,
    fetch: async (url, opts) => ({ json: async () => ({ id_token: idToken(google(opts)) }) }) });
  web = createWeb({ auth, wsUrl: 'wss://chat.example.com/prod', ownerName: 'Pat' });
});
/**
 * Sends an HTTP API event through the Lambda's `route`.
 * @param {string} method - HTTP method.
 * @param {string} rawPath - Request path.
 * @param {Object} [req] - `query`, `headers`, `cookies` and `body` of the request.
 * @returns {Promise<Object>} The Lambda response (`statusCode`, `headers`, `cookies`, `body`).
 */
const http = (method, rawPath, { query = {}, headers = {}, cookies = [], body = '' } = {}) => route({ svc, auth, web },
  { rawPath, queryStringParameters: query, headers, cookies, body, requestContext: { domainName: HOST, http: { method, sourceIp: '1.2.3.4' } } });
/**
 * Finds a cookie a response sets.
 * @param {Object} r - The Lambda response.
 * @param {string} name - Cookie name.
 * @returns {string|undefined} `name=value`, or undefined when it is not set.
 */
const cookieOf = (r, name) => r.cookies.find(c => c.startsWith(name + '='))?.split(';')[0];
/**
 * Starts a sign-in and expects the redirect to Google.
 * @param {string} [path='/login'] - `/login` or `/app/login`.
 * @param {Object} [query] - Query parameters.
 * @returns {Promise<{url: URL, cookie: string}>} Where Google was asked to go, and the msgr_o state cookie.
 */
async function startLogin(path = '/login', query = {}) {
  const r = await http('GET', path, { query });
  assert.equal(r.statusCode, 302);
  return { url: new URL(r.headers.location), cookie: cookieOf(r, 'msgr_o') };
}
/**
 * Builds ID token claims that pass every check.
 * @param {string} nonce - The nonce from the sign-in start.
 * @param {Object} [over] - Claims to override.
 * @returns {Object} The claims.
 */
const goodClaims = (nonce, over = {}) => ({ iss: 'https://accounts.google.com', aud: 'cid', exp: clock / 1000 + 600, nonce, email: OWNER, email_verified: true, ...over });
/**
 * Finishes a sign-in at /oauth2/callback, with Google answering good claims (or overridden ones).
 * @param {{url: URL, cookie: string}} start - The result of startLogin.
 * @param {Object} [over] - Claims to override.
 * @returns {Promise<Object>} The Lambda response.
 */
async function finish(start, over) {
  google = () => goodClaims(start.url.searchParams.get('nonce'), over);
  return http('GET', '/oauth2/callback', { query: { code: 'c', state: start.url.searchParams.get('state') }, cookies: [start.cookie] });
}

test('web sign-in: PKCE to Google, then a session cookie for the allowed account', async () => {
  const s = await startLogin();
  assert.equal(s.url.host, 'accounts.google.com');
  assert.equal(s.url.searchParams.get('redirect_uri'), `https://${HOST}/oauth2/callback`);
  assert.equal(s.url.searchParams.get('code_challenge_method'), 'S256');
  const r = await finish(s);
  assert.equal(r.statusCode, 302); assert.equal(r.headers.location, '/');
  const sess = verify(cookieOf(r, 'msgr_s').slice('msgr_s='.length), KEY, clock);
  assert.equal(sess.e, OWNER); assert.equal(sess.k, 'web');
  assert.match(r.cookies.find(c => c.startsWith('msgr_s=')), /HttpOnly; SameSite=Lax/);
  assert.match(r.cookies.find(c => c.startsWith('msgr_s=')), /Secure/);
});

test('app sign-in ends at the app scheme with the same state, and that token works on the owner API', async () => {
  const state = 'a'.repeat(32);
  const r = await finish(await startLogin('/app/login', { state }));
  const to = new URL(r.headers.location);
  assert.equal(to.protocol, 'webmessenger:'); assert.equal(to.searchParams.get('state'), state);
  const ok = await http('GET', '/owner/settings', { headers: { authorization: 'Bearer ' + to.searchParams.get('token') } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await http('GET', '/app/login', { query: { state: 'short' } })).statusCode, 400);
});

test('sign-in is refused: other account, unverified email, wrong audience, wrong nonce, bad state, no cookie', async () => {
  assert.equal((await finish(await startLogin(), { email: 'x@example.com' })).statusCode, 403);
  assert.equal((await finish(await startLogin(), { email_verified: false })).statusCode, 403);
  assert.equal((await finish(await startLogin(), { aud: 'other' })).statusCode, 403);
  assert.equal((await finish(await startLogin(), { nonce: 'other' })).statusCode, 403);
  const s = await startLogin();
  assert.equal((await http('GET', '/oauth2/callback', { query: { code: 'c', state: 'wrong' }, cookies: [s.cookie] })).statusCode, 400);
  assert.equal((await http('GET', '/oauth2/callback', { query: { code: 'c', state: s.url.searchParams.get('state') } })).statusCode, 400);
  clock += 601000;
  assert.equal((await finish(s)).statusCode, 400, 'the login state expires');
});

test('pages: inbox needs sign-in; widget and demo are public; the widget knows its socket; unknown paths 404', async () => {
  const out = await http('GET', '/');
  assert.equal(out.statusCode, 302); assert.equal(out.headers.location, '/login');
  const cookie = 'msgr_s=' + sign({ e: OWNER, k: 'web', exp: clock / 1000 + 60 }, KEY);
  const inbox = await route({ svc, auth, web: createWeb({ auth: { signedIn: async () => true }, wsUrl: 'wss://chat.example.com/prod' }) },
    { rawPath: '/', headers: {}, cookies: [cookie], requestContext: { domainName: HOST, http: { method: 'GET' } } });
  assert.equal(inbox.statusCode, 200);
  assert.match(inbox.headers['content-security-policy'], /connect-src 'self' wss:\/\/chat\.example\.com/);
  assert.match(inbox.headers['content-security-policy'], /frame-ancestors 'none'/);
  const js = await http('GET', '/widget/chat.js');
  assert.match(js.body, /^window\.MESSENGER_DEFAULTS=\{"ws":"wss:\/\/chat\.example\.com\/prod","ownerName":"Pat"\}/);
  assert.equal((await http('GET', '/widget/chat.css')).statusCode, 200);
  assert.equal((await http('GET', '/demo')).statusCode, 200);
  assert.equal((await http('GET', '/nope')).statusCode, 404);
  assert.equal((await http('GET', '/widget/../handler.mjs')).statusCode, 404);
});

test('owner API through the Lambda mapping: 401 signed out; the ticket says where the socket is', async () => {
  assert.equal((await http('GET', '/owner/settings')).statusCode, 401);
  const headers = { authorization: 'Bearer ' + sign({ e: OWNER, k: 'app', exp: clock / 1000 + 60 }, KEY) };
  const t = JSON.parse((await http('POST', '/owner/ticket', { headers })).body);
  assert.equal(t.ws, 'wss://chat.example.com'); assert.equal(verify(t.ticket, KEY, clock).k, 'ws');
  assert.equal((await http('PUT', '/owner/settings', { headers, body: '{}' })).statusCode, 200, 'an empty change is fine');
});

/**
 * Sends a WebSocket API event through `route`.
 * @param {string} eventType - `CONNECT`, `MESSAGE` or `DISCONNECT`.
 * @param {string} connectionId - Connection id.
 * @param {Object} [extra] - More event fields.
 * @returns {Promise<Object>} The Lambda response.
 */
const ws = (eventType, connectionId, extra = {}) => route({ svc, auth, web }, { ...extra, requestContext: { eventType, connectionId, identity: { sourceIp: '73.1.2.3' } } });
/**
 * Opens a visitor socket on /pricing and says hello.
 * @param {string} id - Connection id.
 * @param {Object} [query] - Query parameters to add or override.
 * @param {Object} [headers=UA] - Handshake headers.
 * @returns {Promise<void>}
 */
async function open(id, query = {}, headers = UA) {
  const r = await ws('CONNECT', id, { queryStringParameters: { role: 'visitor', vid: VID, page: '/pricing', persist: '1', ...query }, headers });
  assert.equal(r.statusCode, 200);
  await ws('MESSAGE', id, { body: JSON.stringify({ action: 'hello' }) });
}
/**
 * Registers an iPhone directly in the store.
 * @returns {Promise<boolean>} The store's answer.
 */
const addPhone = () => store.put({ pk: 'DEVICE', sk: 'ab'.repeat(32), env: 'sandbox' });

test('a page load is a visit: counted, announced, one per 30 minutes, and remembered for the profile', async () => {
  await addPhone();
  await open('c1', { ref: 'https://www.google.com/search' });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].aps.alert.title, 'New visitor');
  assert.equal(pushes[0].aps.alert.body, 'Phone · iOS · Safari · /pricing · from google.com');
  await open('c2', { page: '/about' });
  assert.equal(pushes.length, 1, 'a second page soon after is the same visit');
  clock += 31 * 60000;
  await open('c3');
  assert.equal(pushes[1].aps.alert.title, 'Returning visitor · 2nd visit');
  const p = await store.get('VISITOR#' + VID, 'META');
  assert.equal(p.visits, 2); assert.deepEqual(p.pages, ['/pricing', '/about']); assert.deepEqual(p.ips, ['73.1.2.3']);
});

test('opted out: announced once as new, nothing stored. The owner\'s own browser (me=1) is never announced', async () => {
  await addPhone();
  await open('c1', { persist: '0' });
  assert.equal(pushes.length, 1);
  assert.equal(await store.get('VISITOR#' + VID, 'META'), null);
  await open('c2', { vid: 'OwnerAAAA1111bbbb2233', me: '1' });
  assert.equal(pushes.length, 1);
  assert.equal(await store.get('VISITOR#OwnerAAAA1111bbbb2233', 'META'), null);
});

test('WebSocket and reminder events reach the service through the same mapping', async () => {
  await open('c1');
  assert.equal(sent.c1[0].type, 'hello');
  assert.equal((await ws('DISCONNECT', 'c1')).statusCode, 200);
  assert.equal(await store.get('CONN#c1', 'META'), null);
  assert.deepEqual(await route({ svc, auth, web }, { Records: [{ body: JSON.stringify({ vid: VID, at: 1, n: 1 }) }] }), {});
});

test('deviceFrom gives short labels', () => {
  assert.equal(deviceFrom(UA['user-agent']), 'Phone · iOS · Safari');
  assert.equal(deviceFrom('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), 'Desktop · macOS · Chrome');
  assert.equal(deviceFrom('Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Desktop · Windows · Firefox');
});

test('the DynamoDB Local table matches the template', () => {
  const t = fs.readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
  for (const a of TABLE_SCHEMA.AttributeDefinitions) assert.ok(t.includes(`{ AttributeName: ${a.AttributeName}, AttributeType: ${a.AttributeType} }`), a.AttributeName);
  assert.ok(t.includes('IndexName: byLast'));
  assert.ok(t.includes('[{ AttributeName: gpk, KeyType: HASH }, { AttributeName: gsk, KeyType: RANGE }]'));
});
