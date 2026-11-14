/**
 * @file chat.test.mjs
 * Tests for the chat service, sessions, the APNs token, email parsing and the DynamoDB store.
 *   node --test aws/chat/test/chat.test.mjs   (the whole chat service in memory: no AWS, no Apple)
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createService, LIMITS } from '../src/service.mjs';
import { createMemoryStore, createDynamoStore } from '../src/store.mjs';
import { sign, verify, ownerFrom } from '../src/session.mjs';
import { apnsJwt } from '../src/apns.mjs';
import { parseEmail } from '../src/mail.mjs';

/** The session key and the owner's address used in every test. */
const KEY = 'k'.repeat(64), OWNER = 'owner@example.com';
/** Two well-formed visitor ids. */
const VID = 'VisitorAAAA1111bbbb22', VID2 = 'VisitorBBBB3333cccc44';
/** Per-test state: the fake clock (ms), the store, frames per socket, pushes, sockets marked gone, the service, scheduled jobs and sent emails. */
let clock, store, sockets, pushes, gone, svc, jobs, mails;

/** Before each test: a fixed clock, an empty store with one remembered visitor, and a service whose sockets, pushes, reminders and emails are recorded instead of sent. */
beforeEach(async () => {
  clock = Date.UTC(2026, 9, 31, 18, 0, 0);
  store = createMemoryStore(() => clock); sockets = {}; pushes = []; gone = new Set(); jobs = []; mails = [];
  await store.put({ pk: 'VISITOR#' + VID, sk: 'META', visits: 5, places: ['Springfield, Ohio, US'], devs: ['Phone · iOS · Safari'] });
  svc = createService({
    store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: () => {},
    siteUrl: 'https://example.com', ownerName: 'Pat Owner', wsUrl: 'wss://chat.example.com', apnsTopic: 'com.example.messenger', schedule: async (job, delay) => { jobs.push({ job, delay }); }, sendEmail: async m => { mails.push(m); },
    post: async (id, msg) => { if (gone.has(id)) return 'gone'; (sockets[id] ||= []).push(msg); return 'ok'; },
    push: async (device, payload, opts) => { pushes.push({ device, payload, opts }); return device.token.startsWith('dead') ? { status: 410, reason: 'Unregistered' } : { status: 200 }; },
  });
});
/**
 * Builds the owner's Authorization header with a fresh app session.
 * @param {Object} [extra] - Fields to add to or override in the session.
 * @returns {{authorization: string}} The header.
 */
const bearer = (extra = {}) => ({ authorization: 'Bearer ' + sign({ e: OWNER, k: 'app', exp: clock / 1000 + 3600, ...extra }, KEY) });
/**
 * Calls the owner HTTP API on the service.
 * @param {string} method - HTTP method.
 * @param {string} p - Path under /owner/.
 * @param {Object} [body] - JSON body.
 * @param {Object} [headers] - Request headers (default: the owner's bearer).
 * @returns {Promise<{status: number, body: Object}>} The response.
 */
const http = (method, p, body, headers = bearer()) => svc.http({ method, path: p, headers, body: body ? JSON.stringify(body) : '' });
/**
 * Lists the frames a socket received.
 * @param {string} id - Connection id.
 * @param {string} [type] - Only frames of this type.
 * @returns {Object[]} The frames.
 */
const frames = (id, type) => (sockets[id] || []).filter(m => !type || m.type === type);
/** Headers of a real phone browser on the allowed site. */
const BROWSER = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', origin: 'https://example.com' };
/**
 * Opens a visitor socket like a real browser tab: connects, says hello, and a person takes a couple of seconds before typing.
 * me=1 keeps the visit announcement out of these tests' push counts; 'visits' tests below turn it on.
 * @param {string} conn - Connection id.
 * @param {string} [vid=VID] - Visitor id.
 * @param {string} [page='/'] - The page the visitor is on.
 * @param {Object} [opts] - Options.
 * @param {string} [opts.ip] - The visitor's address.
 * @param {Object} [opts.headers] - Handshake headers.
 * @param {boolean} [opts.wait=true] - Move the clock two seconds on, past the too-fast check.
 * @returns {Promise<void>}
 */
async function visitor(conn, vid = VID, page = '/', { ip = '73.1.2.3', headers = BROWSER, wait = true } = {}) {
  assert.equal(await svc.wsConnect({ connId: conn, query: { role: 'visitor', vid, sid: 'tab' + conn.padEnd(8, 'x'), page, persist: '1', me: '1' }, headers, ip }), 200);
  await svc.wsMessage(conn, JSON.stringify({ action: 'hello' }));
  if (wait) clock += 2000;
}
/**
 * Opens an owner socket with a ticket.
 * @param {string} conn - Connection id.
 * @returns {Promise<void>}
 */
async function owner(conn) {
  const t = await http('POST', '/owner/ticket');
  assert.equal(await svc.wsConnect({ connId: conn, query: { role: 'owner', ticket: t.body.ticket } }), 200);
}
/**
 * Registers an iPhone for pushes.
 * @param {string} [token] - APNs device token (hex).
 * @param {string} [env='sandbox'] - APNs environment.
 * @returns {Promise<void>}
 */
async function device(token = 'ab'.repeat(32), env = 'sandbox') { assert.equal((await http('POST', '/owner/devices', { token, env })).status, 200); }

test('sessions are are byte-compatible across languages (reference made in Python)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const py = `import sys,json,base64,hmac,hashlib
payload=base64.urlsafe_b64encode(json.dumps({"e":"${OWNER}","exp":4102444800,"k":"app"},separators=(",",":")).encode()).rstrip(b"=").decode()
print(payload+"."+hmac.new(b"${KEY}",payload.encode(),hashlib.sha256).hexdigest())`;
  const fromPy = execFileSync('python3', ['-I', '-c', py], { cwd: here }).toString().trim();
  assert.deepEqual(verify(fromPy, KEY), { e: OWNER, exp: 4102444800, k: 'app' });
  assert.equal(sign({ e: OWNER, exp: 4102444800, k: 'app' }, KEY), fromPy, 'Node signs exactly like Python');
  assert.equal(verify(fromPy.slice(0, -1) + '0', KEY), null);
  assert.equal(verify(sign({ e: OWNER, exp: 1 }, KEY), KEY), null, 'expired');
  assert.equal(ownerFrom({ cookies: ['wm_s=' + sign({ e: OWNER, exp: 4102444800 }, KEY)] }, KEY, OWNER).e, OWNER);
  assert.equal(ownerFrom({ cookies: ['wm_s=' + sign({ e: 'x@example.com', exp: 4102444800 }, KEY)] }, KEY, OWNER), null, 'other email');
  assert.equal(ownerFrom({ ticket: sign({ e: OWNER, exp: 4102444800 }, KEY) }, KEY, OWNER), null, 'a web session is not a ticket');
});

test('a visitor writes: owner sockets get it, the phone rings once, the visitor sees the echo', async () => {
  await owner('o1'); await visitor('v1'); await visitor('v1b');           // same visitor, two tabs
  await device();
  assert.equal(frames('o1', 'visitor')[0].event, 'online');
  const hello = frames('v1', 'hello')[0];
  assert.equal(hello.online, true); assert.deepEqual(hello.messages, []); assert.match(hello.greeting, /Ask me anything/);

  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: '  Hi there!  ', name: 'Ada', email: 'ada@example.com' }));
  const m = frames('o1', 'message')[0];
  assert.equal(m.message.text, 'Hi there!'); assert.equal(m.message.from, 'visitor');
  assert.deepEqual({ name: m.conversation.name, email: m.conversation.email, unread: m.conversation.unread, online: m.conversation.online, visits: m.conversation.visits, place: m.conversation.place },
    { name: 'Ada', email: 'ada@example.com', unread: 1, online: true, visits: 5, place: 'Springfield, Ohio, US' });
  assert.equal(frames('v1b', 'message').length, 1, 'other tab sees it too');

  assert.equal(pushes.length, 1);
  const aps = pushes[0].payload.aps;
  assert.equal(aps.sound, 'message-long.caf'); assert.equal(aps.category, 'MESSAGE'); assert.equal(aps['interruption-level'], 'time-sensitive');
  assert.equal(aps.alert.title, 'Ada'); assert.equal(aps.badge, 1); assert.equal(pushes[0].payload.vid, VID);
  assert.equal(pushes[0].opts.topic, 'com.example.messenger');

  clock += 5000;
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'are you there?' }));
  assert.equal(pushes.length, 2); assert.equal(pushes[1].payload.aps.sound, undefined, 'second within 20 s is silent'); assert.equal(pushes[1].payload.aps.badge, 2);
  clock += 21000;
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'hello??' }));
  assert.equal(pushes[2].payload.aps.sound, 'message-long.caf', 'rings again after 20 s');
});

test('the owner replies from the app (HTTP) and the visitor\'s tabs get it; read clears unread', async () => {
  await visitor('v1'); await owner('o1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'question' }));
  const r = await http('POST', `/owner/conversations/${VID}/messages`, { text: 'answer' });
  assert.equal(r.status, 200); assert.equal(r.body.message.from, 'owner');
  assert.equal(frames('v1', 'message').at(-1).message.text, 'answer');
  const list = await http('GET', '/owner/conversations');
  assert.equal(list.body.conversations[0].lastText, 'answer'); assert.equal(list.body.conversations[0].unread, 1);
  assert.equal((await http('POST', `/owner/conversations/${VID}/read`)).status, 200);
  assert.equal((await http('GET', '/owner/conversations')).body.conversations[0].unread, 0);
  assert.equal(frames('v1', 'read').length, 1);
  const msgs = (await http('GET', `/owner/conversations/${VID}/messages`)).body.messages;
  assert.deepEqual(msgs.map(m => [m.from, m.text]), [['visitor', 'question'], ['owner', 'answer']]);
  await svc.wsMessage('v1', JSON.stringify({ action: 'hello' }));
  assert.equal(frames('v1', 'hello').at(-1).messages.length, 2, 'history on return');
});

test('owner over WebSocket: send, typing, read; and "say hi" to someone who never wrote', async () => {
  await visitor('v2', VID2); await owner('o1');
  await svc.wsMessage('o1', JSON.stringify({ action: 'typing', vid: VID2 }));
  assert.equal(frames('v2', 'typing').length, 1);
  await svc.wsMessage('o1', JSON.stringify({ action: 'send', vid: VID2, text: 'Hi! Welcome.' }));
  assert.equal(frames('v2', 'message')[0].message.text, 'Hi! Welcome.');
  assert.equal(frames('o1', 'message')[0].conversation.online, true);
  assert.equal(pushes.length, 0, 'the owner\'s own messages never ring the phone');
});

test('auth: no token 401; forged 401; cookie POST needs JSON; never 404', async () => {
  assert.equal((await svc.http({ method: 'GET', path: '/owner/conversations', headers: {} })).status, 401);
  assert.equal((await http('GET', '/owner/conversations', null, { authorization: 'Bearer ' + sign({ e: OWNER, exp: clock / 1000 + 60 }, 'wrong') })).status, 401);
  const cookie = 'wm_s=' + sign({ e: OWNER, exp: clock / 1000 + 60 }, KEY);
  assert.equal((await svc.http({ method: 'GET', path: '/owner/settings', headers: { cookie } })).status, 200);
  assert.equal((await svc.http({ method: 'PUT', path: '/owner/settings', headers: { cookie, 'content-type': 'text/plain' }, body: '{"available":false}' })).status, 415);
  assert.equal((await svc.http({ method: 'PUT', path: '/owner/settings', headers: { cookie, 'content-type': 'application/json' }, body: '{"available":false}' })).status, 200);
  assert.equal((await http('GET', '/owner/nope')).status, 400);
  assert.equal(await svc.wsConnect({ connId: 'x', query: { role: 'owner' } }), 401);
  assert.equal(await svc.wsConnect({ connId: 'x', query: { role: 'owner', ticket: 'nope' } }), 401);
  assert.equal(await svc.wsConnect({ connId: 'x', query: { role: 'visitor', vid: 'bad id!' }, headers: BROWSER }), 400);
});

test('presence: turning "available" off tells every open visitor tab', async () => {
  await visitor('v1'); await visitor('v2', VID2);
  await http('PUT', '/owner/settings', { available: false, greeting: 'Back soon', visitPings: 'returning' });
  assert.deepEqual(frames('v1', 'presence'), [{ type: 'presence', online: false }]);
  assert.equal(frames('v2', 'presence').length, 1);
  assert.deepEqual((await http('GET', '/owner/settings')).body, { available: false, visitPings: 'returning', greeting: 'Back soon' });
});

test('visit pushes: soft ding, once per visitor per 30 min, settings respected, bots skipped', async () => {
  await device();
  let r = await svc.visit({ kind: 'visit', vid: VID, visits: 5, place: 'Springfield, OH', device: 'iPhone', page: '/', ref: 'https://www.google.com/search?q=x' });
  assert.equal(r.pushed, 1);
  const aps = pushes[0].payload.aps;
  assert.equal(aps.alert.title, 'Returning visitor · 5th visit'); assert.equal(aps.alert.body, 'Springfield, OH · iPhone · / · from google.com');
  assert.equal(aps.sound, 'visit.caf'); assert.equal(aps.category, 'VISIT'); assert.equal(aps['thread-id'], 'visits');
  assert.equal((await svc.visit({ vid: VID, visits: 5 })).why, 'recent');
  clock += 31 * 60 * 1000;
  assert.equal((await svc.visit({ vid: VID, visits: 6 })).pushed, 1);
  assert.equal((await svc.visit({ vid: VID2, visits: 1, bot: true })).why, 'bot');
  await http('PUT', '/owner/settings', { visitPings: 'returning' });
  assert.equal((await svc.visit({ vid: VID2, visits: 1 })).why, 'settings');
  await http('PUT', '/owner/settings', { visitPings: 'off' });
  assert.equal((await svc.visit({ vid: 'Someone99999999', visits: 9 })).why, 'settings');
  await http('PUT', '/owner/settings', { visitPings: 'all' });
  assert.equal((await svc.visit({ sid: 'anonymoustab123', visits: 1 })).pushed, 1, 'opted-out visitors (tab id only) still announce, unlinked');
  assert.match(pushes.at(-1).payload.aps.alert.title, /New visitor/);
});

test('visit pushes are capped at 30 an hour', async () => {
  await device();
  let sent = 0;
  for (let i = 0; i < 40; i++) sent += (await svc.visit({ vid: 'Visitor' + String(i).padStart(8, '0'), visits: 1 })).pushed;
  assert.equal(sent, 30);
});

test('blocked visitors never ring; spam is rate limited', async () => {
  await device(); await visitor('v1');
  await http('POST', `/owner/conversations/${VID}/block`, { blocked: true });
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'spam' }));
  assert.equal(pushes.length, 0);
  assert.equal((await svc.visit({ vid: VID, visits: 3 })).why, 'blocked');
  for (let i = 0; i < 12; i++) await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'spam ' + i }));
  assert.match(frames('v1', 'error').at(-1).error, /Slow down/);
  assert.equal((await http('GET', `/owner/conversations/${VID}/messages`)).body.messages.length, LIMITS.perVidMinute, 'a minute\'s worth, the rest refused');
});

test('dead sockets and dead devices are cleaned up', async () => {
  await owner('o1'); await owner('o2'); await visitor('v1');
  await device('dead' + 'ab'.repeat(30)); await device('cd'.repeat(32), 'production');
  gone.add('o2');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'hi' }));
  assert.deepEqual((await store.query('OWNERS')).map(r => r.sk), ['o1']);
  assert.deepEqual((await store.query('DEVICE')).map(r => [r.sk, r.env]), [['cd'.repeat(32), 'production']]);
  await svc.wsDisconnect('v1');
  assert.equal(frames('o1', 'visitor').at(-1).event, 'offline');
  assert.equal((await http('GET', '/owner/conversations')).body.conversations[0].online, false);
});

test('test pushes from Settings', async () => {
  await device();
  assert.equal((await http('POST', '/owner/test-push', { kind: 'message' })).body.sent, 1);
  assert.equal(pushes[0].payload.aps.sound, 'message-long.caf');
  assert.equal((await http('POST', '/owner/test-push', { kind: 'visit' })).body.sent, 1);
  assert.equal(pushes[1].payload.aps.sound, 'visit.caf');
  assert.equal((await http('POST', '/owner/devices', { token: 'not-hex' })).status, 400);
});

test('APNs token (JWT) is a valid ES256 signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwt = apnsJwt({ keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'ABC123DEFG', teamId: 'ABCDE12345' }, 1_800_000_000_000);
  const [h, b, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(JSON.parse(Buffer.from(b, 'base64url')), { iss: 'ABCDE12345', iat: 1_800_000_000 });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('bots and other sites never get a visitor socket', async () => {
  for (const ua of ['', 'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 HeadlessChrome/120', 'node-fetch/1.0', 'node']) {
    assert.equal(await svc.wsConnect({ connId: 'b', query: { role: 'visitor', vid: VID }, headers: { 'user-agent': ua, origin: BROWSER.origin } }), 403, ua);
  }
  const strict = createService({ store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: () => {},
    post: async () => 'ok', push: async () => ({ status: 200 }), allowedOrigins: ['https://example.com'] });
  assert.equal(await strict.wsConnect({ connId: 'o', query: { role: 'visitor', vid: VID }, headers: { ...BROWSER, origin: 'https://evil.example' } }), 403);
  assert.equal(await strict.wsConnect({ connId: 'o', query: { role: 'visitor', vid: VID }, headers: BROWSER }), 200);
});

test('a message sent faster than a person could is refused', async () => {
  await device(); await visitor('v1', VID, '/', { wait: false });
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'instant' }));
  assert.match(frames('v1', 'error').at(-1).error, /still connecting/);
  const noHello = 'nohello1';
  await svc.wsConnect({ connId: noHello, query: { role: 'visitor', vid: VID2 }, headers: BROWSER, ip: '9.9.9.9' }); clock += 5000;
  await svc.wsMessage(noHello, JSON.stringify({ action: 'send', text: 'no hello first' }));
  assert.match(frames(noHello, 'error').at(-1).error, /still connecting/);
  assert.equal(pushes.length, 0);
  clock += 2000;
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'now it works' }));
  assert.equal(pushes.length, 1);
});

test('the same text twice is dropped; link spam is kept but never rings', async () => {
  await device(); await visitor('v1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'Hello there' }));
  clock += 30000;
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: '  hello   THERE ' }));
  assert.match(frames('v1', 'error').at(-1).error, /already sent/);
  assert.equal(pushes.length, 1);
  clock += 30000;
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'cheap seo http://a.example https://b.example www.c.example buy.xyz' }));
  assert.equal(pushes.length, 1, 'no ring for link spam');
  const c = (await http('GET', '/owner/conversations')).body.conversations[0];
  assert.equal(c.suspect, true); assert.match(c.lastText, /cheap seo/);
});

test('hourly and daily caps per visitor, and per network across visitor ids', async () => {
  await visitor('v1');
  let ok = 0;
  for (let i = 0; i < LIMITS.perVidHour + 5; i++) {
    clock += 61000;                                      // stay under the per-minute limit
    const before = frames('v1', 'error').length;
    await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'message number ' + i }));
    if (frames('v1', 'error').length === before) ok++;
  }
  assert.ok(ok <= LIMITS.perVidHour + 1 && ok >= LIMITS.perVidHour - 1, String(ok));     // an hour boundary may fall inside
  // a bot rotating visitor ids from one address: only so many new conversations a day
  let started = 0;
  for (let i = 0; i < 8; i++) {
    const id = 'Rotating' + String(i).padStart(10, '0'), conn = 'r' + i;
    await visitor(conn, id, '/', { ip: '203.0.113.7' });
    await svc.wsMessage(conn, JSON.stringify({ action: 'send', text: 'hi from ' + i }));
    if (!frames(conn, 'error').length) started++;
  }
  assert.equal(started, LIMITS.newConvsPerIpDay);
  assert.match(frames('r7', 'error')[0].error, /Too many new chats/);
});

test('at most so many message notifications an hour, however many people write', async () => {
  await device();
  for (let i = 0; i < LIMITS.msgPushesPerHour + 10; i++) {
    const id = 'Crowd' + String(i).padStart(12, '0');
    await visitor('c' + i, id, '/', { ip: '198.51.100.' + (i % 250), wait: false });
  }
  clock += 2000;
  for (let i = 0; i < LIMITS.msgPushesPerHour + 10; i++) await svc.wsMessage('c' + i, JSON.stringify({ action: 'send', text: 'hello ' + i }));
  assert.equal(pushes.length, LIMITS.msgPushesPerHour);
  assert.equal((await svc.http({ method: 'GET', path: '/owner/conversations', query: { limit: '200' }, headers: bearer() })).body.conversations.length, LIMITS.msgPushesPerHour + 10, 'all kept');
});

test('an unanswered chat rings again every 2 minutes, up to 5 times, and stops once read or answered', async () => {
  await device(); await visitor('v1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'Are you there?' }));
  assert.equal(pushes.length, 1); assert.equal(jobs.length, 1); assert.equal(jobs[0].delay, LIMITS.remindEveryS);
  for (let n = 1; n <= LIMITS.reminders; n++) {
    clock += LIMITS.remindEveryS * 1000;
    const r = await svc.remind(jobs.at(-1).job);
    assert.equal(r.rang, true, 'reminder ' + n);
    assert.equal(pushes.at(-1).payload.aps.sound, 'message-long.caf');
    assert.match(pushes.at(-1).payload.aps.alert.title, /^Still waiting/);
  }
  assert.equal(pushes.length, 1 + LIMITS.reminders);
  assert.equal(jobs.length, LIMITS.reminders, 'no sixth reminder is scheduled');
  // read: the next reminder does nothing
  await visitor('v2', VID2);
  await svc.wsMessage('v2', JSON.stringify({ action: 'send', text: 'Hello?' }));
  const job = jobs.at(-1).job;
  await http('POST', `/owner/conversations/${VID2}/read`);
  clock += 120000;
  assert.equal((await svc.remind(job)).why, 'read');
  // answered without opening (reply from the lock screen)
  clock += 60000;
  await svc.wsMessage('v2', JSON.stringify({ action: 'send', text: 'Still there?' }));
  const job2 = jobs.at(-1).job;
  clock += 1000;
  await http('POST', `/owner/conversations/${VID2}/messages`, { text: 'Yes! Sorry.' });
  clock += 120000;
  assert.equal((await svc.remind(job2)).rang, false);
  assert.equal((await svc.remind(job2)).rang, false, 'and a duplicate delivery is harmless');
});

test('blocked or suspect chats never get reminders', async () => {
  await device(); await visitor('v1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'hi' }));
  await http('POST', `/owner/conversations/${VID}/block`, { blocked: true });
  clock += 120000;
  assert.equal((await svc.remind(jobs[0].job)).rang, false);
});

test('email to info@ lands in the same inbox, rings, and replies go back as email', async () => {
  await device(); await owner('o1');
  const raw = ['From: "Ada Lovelace" <Ada@Example.com>', 'To: info@example.com', 'Subject: =?utf-8?Q?Quick_question_=E2=80=94_internship?=',
    'Message-ID: <abc123@example.com>', 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Hi Pat,=0AIs the team hiring?', '', 'On Tue, Bob wrote:', '> old stuff', '--b1', 'Content-Type: text/html', '', '<p>Hi</p>', '--b1--'].join('\r\n');
  const m = parseEmail(raw);
  assert.deepEqual({ from: m.from, name: m.name, subject: m.subject, text: m.text },
    { from: 'ada@example.com', name: 'Ada Lovelace', subject: 'Quick question — internship', text: 'Hi Pat,\nIs the team hiring?' });
  const r = await svc.email(m);
  assert.equal(r.stored, true); assert.equal(r.rang, true);
  assert.equal(pushes[0].payload.aps.alert.title, 'Ada Lovelace'); assert.equal(pushes[0].payload.aps.sound, 'message-long.caf');
  const c = frames('o1', 'message')[0].conversation;
  assert.equal(c.channel, 'email'); assert.equal(c.email, 'ada@example.com');
  assert.equal(jobs.length, 1, 'rings until answered, like a chat');
  const reply = await http('POST', `/owner/conversations/${r.vid}/messages`, { text: 'Not yet, but soon!' });
  assert.equal(reply.status, 200);
  assert.deepEqual(mails[0], { to: 'ada@example.com', subject: 'Re: Quick question — internship', text: 'Not yet, but soon!', inReplyTo: '<abc123@example.com>' });
  // same sender again: same conversation
  assert.equal((await svc.email({ ...m, text: 'Thanks!' })).vid, r.vid);
});

test('email: spam, bounces and floods are dropped; a failed send is reported, not hidden', async () => {
  assert.equal((await svc.email({ from: 'x@example.com', text: 'buy', spam: true })).why, 'spam');
  assert.equal((await svc.email({ from: 'MAILER-DAEMON@example.com', text: 'bounce' })).why, 'automated sender');
  assert.equal((await svc.email({ from: 'not an address', text: 'x' })).why, 'no sender');
  let stored = 0;
  for (let i = 0; i < 15; i++) stored += (await svc.email({ from: 'flood@example.com', subject: 's' + i, text: 'hello ' + i })).stored ? 1 : 0;
  assert.equal(stored, LIMITS.emailsPerSenderHour);
  const failing = createService({ store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: () => {},
    post: async () => 'ok', push: async () => ({ status: 200 }), sendEmail: async () => { throw new Error('SES sandbox: address not verified'); } });
  const r = await failing.email({ from: 'someone@example.com', subject: 'hi', text: 'hello' });
  const res = await failing.http({ method: 'POST', path: `/owner/conversations/${r.vid}/messages`, headers: bearer(), body: JSON.stringify({ text: 'reply' }) });
  assert.equal(res.status, 502); assert.match(res.body.error, /not verified/);
});

test('a service inquiry keeps name, email, phone and company, on the chat and on the visitor profile', async () => {
  await device(); await owner('o1'); await visitor('v1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: "Hi Pat, I'm interested in your security audit services. SOC 2 soon.",
    name: 'Grace Hopper', email: 'grace@example.com', phone: '(555) 555-0142', company: 'Cobol Co', lead: 'Security audit' }));
  const c = frames('o1', 'message')[0].conversation;
  assert.deepEqual({ name: c.name, email: c.email, phone: c.phone, company: c.company, lead: c.lead, ip: c.ip },
    { name: 'Grace Hopper', email: 'grace@example.com', phone: '(555) 555-0142', company: 'Cobol Co', lead: 'Security audit', ip: '73.1.2.3' });
  assert.equal(pushes[0].payload.aps.alert.title, 'Grace Hopper · Security audit inquiry');
  const p = (await http('GET', '/owner/visitor/' + VID)).body.profile;
  assert.deepEqual({ name: p.name, email: p.email, phone: p.phone, company: p.company, lead: p.lead },
    { name: 'Grace Hopper', email: 'grace@example.com', phone: '(555) 555-0142', company: 'Cobol Co', lead: 'Security audit' });
});

test('a too-short phone is not kept; opted-out visitors are never linked to a profile', async () => {
  await svc.wsConnect({ connId: 'anon', query: { role: 'visitor', vid: VID2, sid: 'tabanon00001', page: '/', persist: '0' }, headers: BROWSER, ip: '9.8.7.6' });
  await svc.wsMessage('anon', JSON.stringify({ action: 'hello' })); clock += 2000;
  await svc.wsMessage('anon', JSON.stringify({ action: 'send', text: 'IT help please', name: 'Anon', email: 'a@example.com', phone: '12', lead: 'IT' }));
  const c = (await http('GET', '/owner/conversations')).body.conversations[0];
  assert.equal(c.phone, ''); assert.equal(c.name, 'Anon'); assert.equal(c.lead, 'IT');
  assert.equal(await store.get('VISITOR#' + VID2, 'META'), null, 'not remembered: no visitor profile');
});

test('DynamoDB requests only name the attributes their expressions use (DynamoDB rejects unused ones)', async () => {
  const sent = [];
  const cmd = name => class { constructor(input) { this.input = input; this.name = name; } };
  const db = { send: async c => { sent.push(c); return { Items: [], Item: null, Attributes: {} }; } };
  const store = await createDynamoStore('wm-chat', { db, GetCommand: cmd('Get'), PutCommand: cmd('Put'), DeleteCommand: cmd('Delete'), QueryCommand: cmd('Query'), UpdateCommand: cmd('Update') });
  const used = c => {
    const i = c.input, exprs = [i.KeyConditionExpression, i.UpdateExpression, i.ConditionExpression, i.FilterExpression, i.ProjectionExpression].filter(Boolean).join(' ');
    for (const k of Object.keys(i.ExpressionAttributeNames || {})) assert.ok(exprs.includes(k), `${c.name}: ${k} unused in "${exprs}"`);
    for (const k of Object.keys(i.ExpressionAttributeValues || {})) assert.ok(exprs.includes(k), `${c.name}: ${k} unused in "${exprs}"`);
  };
  await store.query('OWNERS');
  await store.query('CONV#x', { prefix: 'MSG#' });
  await store.query('CONV#x', { prefix: 'MSG#', before: 'MSG#9', reverse: true, limit: 5 });
  await store.query('CONV#x', { before: 'MSG#9' });
  await store.update('CONV#x', 'META', { set: { a: 1 }, add: { n: 1 }, setIfMissing: { created: 2 } });
  await store.put({ pk: 'x', sk: 'y' }, { ifNotExists: true });
  await store.byLast({ limit: 10 }); await store.byLast({ before: 5 });
  sent.forEach(used);
  assert.equal(sent.length, 8);
});

test('a reply can also go out by email to a chat visitor who left their address; nothing is stored if it fails', async () => {
  await visitor('v1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'send', text: 'Call me back later?', name: 'Ada', email: 'ada@example.com' }));
  await svc.wsDisconnect('v1');                                       // they left the site
  clock += 3 * 3600 * 1000;
  const r = await http('POST', `/owner/conversations/${VID}/messages`, { text: 'Sorry for the wait! Yes, tomorrow at 10?', email: true });
  assert.equal(r.status, 200); assert.equal(r.body.message.emailed, true);
  assert.equal(mails.length, 1); assert.equal(mails[0].to, 'ada@example.com');
  assert.match(mails[0].text, /^Sorry for the wait! Yes, tomorrow at 10\?/); assert.match(mails[0].text, /example\.com\/#chat/);
  // without the checkbox: chat only
  await http('POST', `/owner/conversations/${VID}/messages`, { text: 'no email this time' });
  assert.equal(mails.length, 1);
  // no address on file
  await visitor('v2', VID2); await svc.wsMessage('v2', JSON.stringify({ action: 'send', text: 'anon' }));
  assert.equal((await http('POST', `/owner/conversations/${VID2}/messages`, { text: 'hi', email: true })).status, 400);
  // SES refuses: an error, and the reply is not half-sent
  const failing = createService({ store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: () => {},
    post: async () => 'ok', push: async () => ({ status: 200 }), sendEmail: async () => { throw new Error('address not verified'); } });
  const before = (await http('GET', `/owner/conversations/${VID}/messages`)).body.messages.length;
  const f = await failing.http({ method: 'POST', path: `/owner/conversations/${VID}/messages`, headers: bearer(), body: JSON.stringify({ text: 'x', email: true }) });
  assert.equal(f.status, 502); assert.match(f.body.error, /not verified/);
  assert.equal((await http('GET', `/owner/conversations/${VID}/messages`)).body.messages.length, before);
});

test('owner can start a chat with someone just browsing: listed as online, message reaches their open tab', async () => {
  await owner('o1');
  await visitor('v1', VID, '/#projects');                               // browsing, never wrote
  const ev = frames('o1', 'visitor').at(-1);
  assert.equal(ev.event, 'online'); assert.equal(ev.conversation, null); assert.equal(ev.visitor.place, 'Springfield, Ohio, US');
  await svc.wsConnect({ connId: 'b1', query: { role: 'visitor', vid: VID2, sid: 'tabb1xxxxx', page: '/' }, headers: { ...BROWSER, 'user-agent': BROWSER['user-agent'] + ' HeadlessChrome' }, ip: '1.1.1.1' });
  const on = await http('GET', '/owner/online');
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.visitors.map(v => v.vid), [VID], 'headless tab left out');
  assert.equal(on.body.visitors[0].page, '/#projects'); assert.equal(on.body.visitors[0].conversation, null); assert.equal(on.body.visitors[0].visits, 5);
  const r = await http('POST', `/owner/conversations/${VID}/messages`, { text: 'Hi! Anything I can help with?' });
  assert.equal(r.status, 200);
  const got = frames('v1', 'message').at(-1);
  assert.equal(got.message.from, 'owner'); assert.equal(got.message.text, 'Hi! Anything I can help with?');
  const conv = (await http('GET', '/owner/online')).body.visitors[0].conversation;
  assert.equal(conv.lastFrom, 'owner'); assert.equal(conv.online, true); assert.equal(conv.place, 'Springfield, Ohio, US');
  await svc.wsDisconnect('v1');
  assert.deepEqual((await http('GET', '/owner/online')).body.visitors, []);
});

test('critical alerts (when switched on) ring through silent mode at full volume', async () => {
  const crit = createService({ store, now: () => clock, sessionKey: async () => KEY, allowedEmail: OWNER, log: () => {}, criticalAlerts: true,
    post: async () => 'ok', push: async (device, payload) => { pushes.push({ device, payload }); return { status: 200 }; } });
  await device();
  const r = await crit.http({ method: 'POST', path: '/owner/test-push', headers: bearer(), body: JSON.stringify({ kind: 'message' }) });
  assert.equal(r.body.sent, 1);
  const aps = pushes.at(-1).payload.aps;
  assert.equal(aps['interruption-level'], 'critical'); assert.deepEqual(aps.sound, { critical: 1, name: 'message-long.caf', volume: 1.0 });
});

test('the owner sees the draft as it is typed; the first keystrokes ring the phone once', async () => {
  await owner('o1'); await device(); await visitor('v1');
  await svc.wsMessage('v1', JSON.stringify({ action: 'typing', text: 'Hi, I was wondering' }));
  await svc.wsMessage('v1', JSON.stringify({ action: 'typing', text: 'Hi, I was wondering about pricing' }));
  const ty = frames('o1', 'typing');
  assert.deepEqual(ty.map(f => f.text), ['Hi, I was wondering', 'Hi, I was wondering about pricing']);
  assert.equal(pushes.length, 1, 'one ring for starting to type');
  assert.match(pushes[0].payload.aps.alert.title, /is typing/); assert.equal(pushes[0].payload.aps.alert.body, 'Hi, I was wondering');
  assert.equal(pushes[0].payload.aps.sound, 'message-long.caf'); assert.equal(pushes[0].payload.kind, 'typing');
  await svc.wsMessage('v1', JSON.stringify({ action: 'typing', text: '' }));     // cleared: the preview goes, no ring
  assert.equal(frames('o1', 'typing').at(-1).text, ''); assert.equal(pushes.length, 1);
  clock += 301 * 1000;
  await svc.wsMessage('v1', JSON.stringify({ action: 'typing', text: 'one more thing' }));
  assert.equal(pushes.length, 2, 'rings again after 5 minutes');
  // old clients (no text) still show "typing…", without a ring
  await visitor('v2', VID2); await svc.wsMessage('v2', JSON.stringify({ action: 'typing' }));
  assert.equal(frames('o1', 'typing').at(-1).text, undefined); assert.equal(pushes.length, 2);
});

test('an email conversation cannot be opened as a visitor: its id comes from the sender\'s address, so it is no secret', async () => {
  const r = await svc.email({ from: 'ada@example.com', subject: 'Private', text: 'For the owner only' });
  assert.equal(r.stored, true);
  // anyone who knows the sender's address can work out the conversation id
  const guessed = 'em' + crypto.createHash('sha256').update('ada@example.com').digest('hex').slice(0, 24);
  assert.equal(guessed, r.vid);
  assert.equal(await svc.wsConnect({ connId: 'spy', query: { role: 'visitor', vid: guessed, sid: 'tabspyxxxxx', page: '/' }, headers: BROWSER, ip: '203.0.113.9' }), 400);
  await svc.wsMessage('spy', JSON.stringify({ action: 'hello' }));
  assert.equal(frames('spy', 'hello').length, 0, 'no history is handed out');
  assert.equal((await svc.visitorHttp({ method: 'POST', path: '/visitor/data', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ vid: guessed }) })).status, 400);
  assert.equal((await svc.visitorHttp({ method: 'POST', path: '/visitor/forget', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ vid: guessed }) })).status, 400);
  assert.equal((await http('GET', `/owner/conversations/${r.vid}/messages`)).body.messages.length, 1, 'the owner still has it');
});

test('JSON means JSON: a content type that only mentions application/json is refused', async () => {
  const cookie = 'wm_s=' + sign({ e: OWNER, exp: clock / 1000 + 60 }, KEY);
  // a cross-site form can send these without a preflight, so they must not count as JSON
  for (const type of ['text/plain; application/json', 'text/plain;charset=application/json', 'application/jsonx', 'multipart/form-data; boundary=application/json']) {
    assert.equal((await svc.http({ method: 'PUT', path: '/owner/settings', headers: { cookie, 'content-type': type }, body: '{"available":false}' })).status, 415, type);
    assert.equal((await svc.visitorHttp({ method: 'POST', path: '/visitor/data', headers: { 'content-type': type, origin: 'https://example.com' }, body: JSON.stringify({ vid: VID }) })).status, 415, type);
  }
  assert.equal((await svc.settings()).available, true, 'nothing was changed');
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8']) {
    assert.equal((await svc.http({ method: 'PUT', path: '/owner/settings', headers: { cookie, 'content-type': type }, body: '{"greeting":"Hello"}' })).status, 200, type);
    assert.equal((await svc.visitorHttp({ method: 'POST', path: '/visitor/data', headers: { 'content-type': type, origin: 'https://example.com' }, body: JSON.stringify({ vid: VID }) })).status, 200, type);
  }
});

test('typing rings the phone only after the same wait as a first message', async () => {
  await owner('o1'); await device();
  // connected, but no hello: the draft is shown to an open inbox, the phone stays quiet
  assert.equal(await svc.wsConnect({ connId: 'fast', query: { role: 'visitor', vid: VID2, sid: 'tabfastxxxx', page: '/', me: '1' }, headers: BROWSER, ip: '203.0.113.9' }), 200);
  await svc.wsMessage('fast', JSON.stringify({ action: 'typing', text: 'ring ring' }));
  assert.equal(frames('o1', 'typing').length, 1); assert.equal(pushes.length, 0, 'no hello, no ring');
  // hello, then typing at once: still too fast for a person
  await visitor('v1', VID, '/', { wait: false });
  await svc.wsMessage('v1', JSON.stringify({ action: 'typing', text: 'too fast' }));
  assert.equal(pushes.length, 0, 'sooner than a person could type');
  clock += LIMITS.minHumanMs;
  await svc.wsMessage('v1', JSON.stringify({ action: 'typing', text: 'now a person' }));
  assert.equal(pushes.length, 1); assert.equal(pushes[0].payload.aps.alert.body, 'now a person');
});

test('a malformed address on the owner API is a 400, not a crash', async () => {
  assert.equal((await http('GET', '/owner/conversations/%E0%A4%A/messages')).status, 400);
});
