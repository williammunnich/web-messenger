/**
 * @file chat-dev.mjs
 * Local test bench. Runs the real Lambda code path (aws/chat/src/handler.mjs `route`) with API Gateway shaped events:
 *   node tools/chat-dev.mjs              data in memory
 *   node tools/chat-dev.mjs --dynamo     data in DynamoDB Local (npm run db:up first; same table as the template)
 * http://localhost:8790/demo is a page with the widget, http://localhost:8790/ is the inbox (already signed in).
 * The iPhone app connects too: type localhost:8790 as the host in the Simulator. Pushes are printed instead of sent.
 * REMIND_S=10 makes unanswered-chat reminders come every 10 s instead of every minute.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createService } from '../aws/chat/src/service.mjs';
import { createMemoryStore, createDynamoStore } from '../aws/chat/src/store.mjs';
import { createWeb } from '../aws/chat/src/web.mjs';
import { route } from '../aws/chat/src/handler.mjs';
import { sign } from '../aws/chat/src/session.mjs';

/** Bench settings: the port (PORT, default 8790), a fixed development session key, the owner's address and the local table name. */
const PORT = Number(process.env.PORT || 8790), KEY = 'dev'.repeat(22), OWNER = 'owner@localhost', TABLE = 'messenger-local';
/** The bench's WebSocket address. */
const WS_URL = `ws://localhost:${PORT}/chat`;
/** True when started with --dynamo: data goes to DynamoDB Local instead of memory. */
const useDynamo = process.argv.includes('--dynamo');
/** An owner app session that is valid for a day and only on this bench. */
const TOKEN = sign({ e: OWNER, k: 'app', exp: Math.floor(Date.now() / 1000) + 86400 }, KEY);
/** Open WebSocket connections by connection id. */
const conns = new Map();
/** Counter for connection ids. */
let n = 0;

/**
 * Creates the store: in memory, or DynamoDB Local (creating the table when needed) with --dynamo.
 * @returns {Promise<Object>} The store.
 */
async function makeStore() {
  if (!useDynamo) return createMemoryStore();
  process.env.DYNAMO_ENDPOINT ||= 'http://localhost:8000';
  const { ensureTable } = await import('./dynamo-local.mjs');
  await ensureTable(process.env.DYNAMO_ENDPOINT, TABLE);
  return createDynamoStore(TABLE);
}

/** The chat service wired to the bench: sockets in `conns`, pushes printed, reminders on timers. */
const svc = createService({
  store: await makeStore(), sessionKey: async () => KEY, allowedEmail: OWNER, ownerName: 'Local Owner', wsUrl: WS_URL,
  post: async (id, msg) => { const s = conns.get(id); if (!s) return 'gone'; wsSend(s, JSON.stringify(msg)); return 'ok'; },
  push: async (d, payload) => { console.log('[push]', payload.aps.alert.title, '—', payload.aps.alert.body, payload.aps.sound ? `(${JSON.stringify(payload.aps.sound)})` : '(silent)'); return { status: 200 }; },
  log: o => console.log('[log]', JSON.stringify(o)),
  schedule: async (job, delay) => { setTimeout(() => svc.remind(job), 1000 * Number(process.env.REMIND_S || delay)); },
});
await svc.http({ method: 'POST', path: '/owner/devices', headers: { authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ token: 'ab'.repeat(32) }) });

/** Stand-in for sign-in: the bench is always signed in, and Google isn't involved. */
const auth = { signedIn: async () => true, handle: async r => {
  if (r.path === '/app/login') return { status: 302, headers: { location: 'wmchat://auth?' + new URLSearchParams({ token: TOKEN, state: r.query.state || '' }) }, body: '' };
  if (r.path === '/login' || r.path === '/logout') return { status: 302, headers: { location: '/' }, body: '' };
  return null;
} };
/** The parts `route` needs, as in the Lambda (no `readMail`: the bench gets no email). */
const app = { svc, auth, web: createWeb({ auth, wsUrl: WS_URL, ownerName: 'Local Owner' }) };

/** The HTTP server: turns each request into an HTTP API event for `route`, always as the signed-in owner. */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = ''; for await (const c of req) body += c;
  const headers = { ...req.headers, authorization: 'Bearer ' + TOKEN };
  const r = await route(app, { rawPath: u.pathname, queryStringParameters: Object.fromEntries(u.searchParams), headers, body,
    cookies: [], requestContext: { domainName: `localhost:${PORT}`, http: { method: req.method, sourceIp: req.socket.remoteAddress } } });
  res.writeHead(r.statusCode, r.headers).end(r.body);
});

// ---- a minimal WebSocket server (RFC 6455: text frames, masked client frames, ping/close), standing in for API Gateway
/**
 * Builds a WebSocket API event the way API Gateway shapes it.
 * @param {string} eventType - `CONNECT`, `MESSAGE` or `DISCONNECT`.
 * @param {string} connectionId - The connection id.
 * @param {Object} [extra] - More event fields (query, headers, body).
 * @returns {Object} The event.
 */
const wsEvent = (eventType, connectionId, extra = {}) => ({ ...extra, requestContext: { eventType, connectionId, identity: { sourceIp: '127.0.0.1' } } });
server.on('upgrade', async (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/chat') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const id = 'c' + (++n).toString().padStart(6, '0');
  const { statusCode } = await route(app, wsEvent('CONNECT', id, { queryStringParameters: Object.fromEntries(u.searchParams), headers: req.headers }));
  if (statusCode !== 200) { sock.end(`HTTP/1.1 ${statusCode} No\r\n\r\n`); return; }
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  conns.set(id, sock);
  let buf = Buffer.alloc(0);
  sock.on('data', async d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null, data = Buffer.from(buf.subarray(need - len, need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(need);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op === 1) await route(app, wsEvent('MESSAGE', id, { body: data.toString('utf8') }));
    }
  });
  /**
   * Reports a closed socket to the service, once.
   * @returns {Promise<void>}
   */
  const bye = async () => { if (conns.delete(id)) await route(app, wsEvent('DISCONNECT', id)); };
  sock.on('close', bye); sock.on('error', bye);
});
/**
 * Writes one unmasked WebSocket text frame.
 * @param {import('node:net').Socket} sock - The upgraded socket.
 * @param {string} text - The frame's text.
 * @returns {void}
 */
function wsSend(sock, text) {
  const b = Buffer.from(text), head = b.length < 126 ? Buffer.from([0x81, b.length])
    : b.length < 65536 ? Buffer.from([0x81, 126, b.length >> 8, b.length & 255]) : null;
  if (!head) { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); sock.write(Buffer.concat([h, b])); return; }
  sock.write(Buffer.concat([head, b]));
}

// loopback only: everyone who can reach the bench is signed in as the owner
server.listen(PORT, '127.0.0.1', () => console.log(`messenger bench (${useDynamo ? 'DynamoDB Local' : 'in memory'})\n  widget: http://localhost:${PORT}/demo\n  inbox:  http://localhost:${PORT}/\n  app token (Simulator launch argument -benchToken, works only here): ${TOKEN}`));
