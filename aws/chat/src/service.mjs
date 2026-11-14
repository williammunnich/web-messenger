/**
 * @file service.mjs
 * The chat service: visitors and the owner over WebSocket, the owner's HTTP API, and push notifications.
 * Everything outside (table, sockets, APNs, email, the session key) comes in through `deps`,
 * so tests run it entirely in memory. The contract is docs/chat-protocol.md.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
import crypto from 'node:crypto';
import { sign, ownerFrom } from './session.mjs';

/** The shape of a visitor or session id. */
const ID_RE = /^[A-Za-z0-9]{8,40}$/;
/**
 * The shape of an email conversation's id (see `email`: "em" + 24 hex digits of a hash of the sender's address).
 * Such an id can be worked out by anyone who knows the address, so, unlike a widget's random id, holding it proves
 * nothing. The visitor socket and the visitor data endpoints refuse ids of this shape; only the owner API uses them.
 */
const EMAIL_VID_RE = /^em[0-9a-f]{24}$/;
/**
 * Tells whether a Content-Type header says JSON. The type itself must be application/json (parameters such as
 * a charset may follow). A test for the text "application/json" anywhere in the header is not enough:
 * "text/plain; application/json" contains it, and a cross-site form can send that without a CORS preflight.
 * @param {*} header - The Content-Type header value.
 * @returns {boolean} True for application/json.
 */
const isJson = header => /^application\/json\s*(;|$)/i.test(String(header ?? '').trim());
/** Longest message text that is kept, in characters. */
const MAX_TEXT = 2000;
/** Push pacing: seconds between visit pushes for one visitor, visit pushes per hour in total, and seconds between message sounds for one visitor. */
const VISIT_PUSH_EVERY_S = 30 * 60, VISIT_PUSH_PER_HOUR = 30, MSG_SOUND_EVERY_S = 20;
/**
 * Limits on what reaches the owner (docs/chat-protocol.md, "Throttling and bots"). Messages over a limit are refused
 * with a polite error; messages that look automated are kept (marked suspect) but never ring the phone.
 */
export const LIMITS = {
  perVidMinute: 6, perVidHour: 30, perVidDay: 80,      // one visitor
  perIpHour: 40,                                        // one network address, across visitor ids (id-rotating bots)
  newConvsPerIpDay: 5,                                  // new conversations started from one address per day
  msgPushesPerHour: 40,                                 // message notifications in total; beyond this they're stored silently
  minHumanMs: 1500,                                     // a first message sooner than this after the bubble connects is bot-like
  dupWindowS: 600,                                      // the same text again within 10 minutes is dropped
  maxLinks: 2,                                          // more links than this: kept, marked suspect, no notification
  remindEveryS: 60, reminders: 10, typingPerMinute: 240, typingPushEveryS: 300,                      // an unanswered chat rings again every minute, up to 10 times
  emailsPerSenderHour: 10,                              // the inbox address: one sender, per hour
};
/** User agents that are refused as bots when a visitor socket connects (an empty user agent counts too). */
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|scan|go-http|headless|phantom|puppeteer|playwright|selenium|httpclient|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|^node$|^$/i;
/** Seconds in a day. */
const DAY = 86400;

/**
 * Makes a random id with a prefix, using letters and digits only.
 * @param {string} p - The prefix.
 * @returns {string} The id.
 */
const newId = p => p + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
/**
 * Left-pads a millisecond timestamp to 13 digits so sort keys order by time.
 * @param {number} n - The timestamp.
 * @returns {string} The padded number.
 */
const pad = n => String(n).padStart(13, '0');
/**
 * Turns input into safe text: control characters removed, trimmed and cut to a maximum length.
 * @param {*} s - The input (null and undefined become an empty string).
 * @param {number} n - Maximum length.
 * @returns {string} The cleaned text.
 */
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
/**
 * Describes a device from its user agent as "Phone · iOS · Safari", the same shape the app shows.
 * Coarse on purpose: this is a label, not fingerprinting.
 * @param {string} [ua=''] - The User-Agent header.
 * @returns {string} Kind, operating system and browser joined by " · "; unknown parts are left out.
 */
export function deviceFrom(ua = '') {
  const kind = /iPad|Tablet/i.test(ua) ? 'Tablet' : /iPhone|Android.*Mobile|Mobile/i.test(ua) ? 'Phone' : 'Desktop';
  const os = /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Mac OS X/i.test(ua) ? 'macOS' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [kind, os, browser].filter(Boolean).join(' · ');
}
/**
 * Formats a number as an ordinal ("1st", "2nd", "11th").
 * @param {number} n - The number.
 * @returns {string} The number with its suffix.
 */
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

/**
 * Creates the chat service.
 * @param {Object} deps - Everything the service needs from outside.
 * @param {Object} deps.store - The table (see store.mjs).
 * @param {function(string, Object): Promise<string>} deps.post - Sends a message to a socket; resolves `ok`, `gone` or `error`.
 * @param {function(Object, Object, Object): Promise<{status: number, reason: string}>} deps.push - Sends an APNs notification to one device.
 * @param {function(): Promise<string>} deps.sessionKey - Loads the key that signs sessions.
 * @param {string} deps.allowedEmail - The owner's email.
 * @param {string} [deps.apnsTopic=''] - The app's bundle id.
 * @param {boolean} [deps.criticalAlerts=false] - Send message pushes as critical alerts.
 * @param {string} [deps.ownerName] - The owner's display name (default "Support").
 * @param {string} [deps.siteUrl] - The site the widget is on.
 * @param {string} [deps.wsUrl] - The WebSocket address handed out with tickets.
 * @param {string[]} [deps.allowedOrigins] - Sites that may use the chat; empty means any.
 * @param {function(Object, number): Promise<void>} [deps.schedule] - Runs `remind(job)` after a delay in seconds (SQS in AWS).
 * @param {function(Object): Promise<void>} [deps.sendEmail] - Sends an email; the default always throws.
 * @param {function(): number} [deps.now] - Clock in milliseconds.
 * @param {function(Object): void} [deps.log] - Receives log events (default: JSON to the console).
 * @returns {Object} The service: wsConnect, wsDisconnect, wsMessage, visit, http, settings, remind, email, visitorData, forgetVisitor, visitorHttp.
 */
export function createService(deps) {
  const { store, post, push, sessionKey, allowedEmail, apnsTopic = '', criticalAlerts = false } = deps;
  const ownerName = deps.ownerName || 'Support', siteUrl = (deps.siteUrl || '').replace(/\/$/, ''), wsUrl = deps.wsUrl || '';
  /** The site's host name without "www.", or an empty string when siteUrl does not parse. */
  const siteHost = (() => { try { return new URL(siteUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  /** The owner's settings before any are saved. */
  const DEFAULT_SETTINGS = { available: true, visitPings: 'all', greeting: 'Hi! Ask me anything. I usually reply within a few hours.' };
  const allowedOrigins = deps.allowedOrigins || [];
  /**
   * Schedules a reminder job; a no-op when `deps.schedule` is not given.
   * @param {Object} job - The job passed to `remind` later.
   * @param {number} delaySeconds - How long to wait.
   * @returns {Promise<void>}
   */
  const schedule = deps.schedule || (async () => {});    // (job, delaySeconds): runs remind(job) later (SQS in AWS)
  /**
   * Sends an email through `deps.sendEmail`.
   * @param {Object} mail - `{to, subject, text, inReplyTo}`.
   * @returns {Promise<void>}
   * @throws {Error} When email sending is not set up.
   */
  const sendEmail = deps.sendEmail || (async () => { throw new Error('email sending not set up'); });
  /**
   * The clock.
   * @returns {number} Current time in milliseconds.
   */
  const now = deps.now || (() => Date.now());
  /**
   * Current time in whole seconds.
   * @returns {number} Seconds since the epoch.
   */
  const sec = () => Math.floor(now() / 1000);
  /**
   * Writes one log event.
   * @param {Object} o - The event.
   * @returns {void}
   */
  const log = deps.log || (o => console.log(JSON.stringify(o)));

  // ------------------------------------------------------------------ helpers
  /**
   * Reads the owner's settings, with defaults for anything not saved.
   * @returns {Promise<Object>} The settings (`available`, `visitPings`, `greeting`, plus any other saved fields).
   */
  async function settings() { return { ...DEFAULT_SETTINGS, ...((await store.get('SETTINGS', 'META')) || {}), pk: undefined, sk: undefined }; }
  /**
   * Picks the settings fields the API returns.
   * @param {Object} s - Settings from `settings()`.
   * @returns {{available: boolean, visitPings: string, greeting: string}} The public fields.
   */
  const publicSettings = s => ({ available: !!s.available, visitPings: s.visitPings, greeting: s.greeting });

  /**
   * Sends a message to several sockets, forgetting any connection that is gone.
   * @param {string[]} connIds - Connection ids.
   * @param {Object} msg - The message.
   * @returns {Promise<void>}
   */
  async function sendTo(connIds, msg) {
    await Promise.all(connIds.map(async id => {
      const r = await post(id, msg).catch(() => 'error');
      if (r === 'gone') await dropConn(id);
    }));
  }
  /**
   * Lists the owner's open sockets.
   * @returns {Promise<string[]>} Connection ids.
   */
  const ownerConns = async () => (await store.query('OWNERS')).map(r => r.sk);
  /**
   * Lists one visitor's open sockets.
   * @param {string} vid - Visitor id.
   * @returns {Promise<string[]>} Connection ids.
   */
  const visitorConns = async vid => (await store.query('VCONN#' + vid)).map(r => r.sk);
  /**
   * Sends a message to every owner socket.
   * @param {Object} msg - The message.
   * @returns {Promise<void>}
   */
  const toOwners = async msg => sendTo(await ownerConns(), msg);
  /**
   * Sends a message to every socket of one visitor.
   * @param {string} vid - Visitor id.
   * @param {Object} msg - The message.
   * @returns {Promise<void>}
   */
  const toVisitor = async (vid, msg) => sendTo(await visitorConns(vid), msg);

  /**
   * Removes a connection and its index rows.
   * @param {string} id - Connection id.
   * @returns {Promise<?Object>} The connection row that was removed, or null when there was none.
   */
  async function dropConn(id) {
    const c = await store.get('CONN#' + id, 'META');
    await store.del('CONN#' + id, 'META');
    if (!c) return null;
    if (c.role === 'owner') await store.del('OWNERS', id);
    else { await store.del('VCONN#' + c.vid, id); await store.del('VCONNS', id); }
    return c;
  }

  /**
   * Shapes a stored conversation row for the API, filling defaults.
   * @param {?Object} c - The conversation row.
   * @param {boolean} [online=false] - Whether the visitor has a socket open.
   * @returns {?Object} The conversation as sent to the owner, or null for no row.
   */
  function convOut(c, online = false) {
    if (!c) return null;
    return { vid: c.vid, name: c.name || '', email: c.email || '', lastText: c.lastText || '', lastFrom: c.lastFrom || '',
      lastAt: c.lastAt || 0, unread: c.unread || 0, online, place: c.place || '', device: c.device || '',
      visits: c.visits || 0, blocked: !!c.blocked, suspect: !!c.suspect, channel: c.channel || 'chat',
      phone: c.phone || '', company: c.company || '', lead: c.lead || '', ip: c.ip || '' };
  }
  /**
   * Loads a conversation in API shape, with its online state.
   * @param {string} vid - Visitor id.
   * @returns {Promise<?Object>} The conversation, or null when there is none.
   */
  async function conversation(vid) {
    const c = await store.get('CONV#' + vid, 'META');
    return c ? convOut(c, (await visitorConns(vid)).length > 0) : null;
  }
  /**
   * Shapes a stored message row for the API.
   * @param {Object} m - The message row.
   * @returns {{id: string, vid: string, from: string, text: string, at: number, page: (string|undefined)}} The message.
   */
  const msgOut = m => ({ id: m.id, vid: m.vid, from: m.from, text: m.text, at: m.at, ...(m.page ? { page: m.page } : {}) });
  /**
   * Loads the latest messages of a conversation, oldest first.
   * @param {string} vid - Visitor id.
   * @param {Object} [opts] - Options.
   * @param {number} [opts.limit=100] - Most messages to return (capped at 200).
   * @param {number} [opts.before] - Only messages older than this timestamp (ms).
   * @returns {Promise<Object[]>} The messages.
   */
  async function messages(vid, { limit = 100, before } = {}) {
    const rows = await store.query('CONV#' + vid, { prefix: 'MSG#', limit: Math.min(limit, 200), reverse: true,
      before: before ? 'MSG#' + pad(before) : undefined });
    return rows.reverse().map(msgOut);
  }
  /**
   * Counts unread messages across the 500 most recent conversations, leaving out blocked ones (the app badge).
   * @returns {Promise<number>} The total.
   */
  async function totalUnread() { return (await store.byLast({ limit: 500 })).reduce((n, c) => n + (c.blocked ? 0 : c.unread || 0), 0); }

  /**
   * Reads a remembered visitor's profile. Remembered visitors (docs/chat-protocol.md) have one row per vid in
   * this table, kept 400 days after the last visit.
   * @param {string} vid - Visitor id.
   * @returns {Promise<?Object>} The profile row, or null.
   */
  const profile = vid => store.get('VISITOR#' + vid, 'META');
  /**
   * Sets fields on a visitor's profile, only when a profile already exists.
   * @param {string} vid - Visitor id.
   * @param {Object} fields - Fields to set.
   * @returns {Promise<void>}
   */
  const updateProfile = async (vid, fields) => {
    if (await profile(vid)) await store.update('VISITOR#' + vid, 'META', { set: fields });
  };
  /**
   * Puts an item at the front of a most-recent-first list without duplicates.
   * @param {Array} [list] - The existing list.
   * @param {*} item - The new item; a falsy item leaves the list as it is.
   * @param {number} n - Longest list to keep.
   * @returns {Array} The new list.
   */
  const recent = (list, item, n) => (item ? [item, ...(list || []).filter(x => x !== item)].slice(0, n) : list || []);

  /**
   * Says who the visitor is, from their profile (place, device, visit count). Best effort: a failure is logged
   * and gives an empty object.
   * @param {string} vid - Visitor id.
   * @returns {Promise<Object>} `{place, device, visits}`, or `{}` without a profile.
   */
  async function enrich(vid) {
    try {
      const p = await profile(vid);
      if (!p) return {};
      return { place: (p.places || [])[0] || '', device: (p.devs || [])[0] || '', visits: p.visits || 0 };
    } catch (e) { log({ event: 'profile_failed', vid, error: String(e.message || e).slice(0, 200) }); return {}; }
  }

  /** Timestamp of the last stored message, so each new one gets a strictly later time. */
  let lastAt = 0;
  /**
   * Stores a message and updates its conversation (last text, time, unread count for visitor messages).
   * @param {string} vid - Visitor id.
   * @param {string} from - `visitor` or `owner`.
   * @param {string} text - The message text.
   * @param {Object} [extra] - Extras.
   * @param {string} [extra.page] - The page the visitor was on.
   * @param {Object} [extra.set] - More conversation fields to set.
   * @returns {Promise<{message: Object, conv: Object}>} The message in API shape and the updated conversation row.
   */
  async function addMessage(vid, from, text, extra = {}) {
    const at = lastAt = Math.max(now(), lastAt + 1), id = newId('m_');      // strictly increasing: order is stable
    const m = { pk: 'CONV#' + vid, sk: 'MSG#' + pad(at) + '#' + id, id, vid, from, text, at, ...(extra.page ? { page: extra.page } : {}) };
    await store.put(m);
    const set = { vid, lastText: text.slice(0, 300), lastFrom: from, lastAt: at, gpk: 'CONVS', gsk: at, ...extra.set };
    const c = await store.update('CONV#' + vid, 'META', { set, add: from === 'visitor' ? { unread: 1 } : {}, setIfMissing: { created: at } });
    return { message: msgOut(m), conv: c };
  }

  /**
   * Lists the registered iPhones.
   * @returns {Promise<Object[]>} Device rows (`sk` is the APNs token).
   */
  async function devices() { return store.query('DEVICE'); }
  /**
   * Sends a notification to every registered device, removing devices APNs reports as gone.
   * @param {Object} payload - The APNs payload.
   * @param {Object} opts - Options for the sender (the topic is added here).
   * @returns {Promise<number>} How many devices accepted the push.
   */
  async function pushAll(payload, opts) {
    const list = await devices();
    let sent = 0;
    await Promise.all(list.map(async d => {
      const r = await push({ token: d.sk, env: d.env }, payload, { topic: apnsTopic, ...opts }).catch(e => ({ status: 0, reason: String(e.message) }));
      if (r.status === 200) sent++;
      else {
        log({ event: 'push_failed', status: r.status, reason: r.reason, env: d.env });
        if (r.status === 410 || (r.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(r.reason))) await store.del('DEVICE', d.sk);
      }
    }));
    return sent;
  }
  /**
   * Throttle: resolves true at most once per `seconds` for this key.
   * @param {string} key - The throttle key.
   * @param {number} seconds - The window.
   * @returns {Promise<boolean>} True the first time in the window.
   */
  const once = async (key, seconds) => store.put({ pk: key, sk: '-', exp: sec() + seconds }, { ifNotExists: true });

  /**
   * Pushes a new-message notification. It makes a sound at most once per MSG_SOUND_EVERY_S per visitor,
   * unless it is forced or a reminder.
   * @param {string} vid - Visitor id.
   * @param {Object} conv - The conversation (name, place, lead, blocked).
   * @param {string} text - The message text for the notification body.
   * @param {Object} [opts] - Options.
   * @param {boolean} [opts.force=false] - Push even for a blocked conversation, always with sound.
   * @param {number} [opts.reminder=0] - Reminder number; above 0 the title says "Still waiting".
   * @returns {Promise<number>} How many devices accepted the push (0 for a blocked conversation).
   */
  async function messagePush(vid, conv, text, { force = false, reminder = 0 } = {}) {
    if (conv.blocked && !force) return 0;
    const loud = force || reminder > 0 || await once('THR#msgsound#' + vid, MSG_SOUND_EVERY_S);
    const who = (conv.name || (conv.place ? `Visitor from ${conv.place}` : 'Visitor')) + (conv.lead ? ` · ${conv.lead} inquiry` : '');
    const title = reminder ? `Still waiting · ${who}` : who;
    const aps = { alert: { title, body: text.slice(0, 180) }, 'thread-id': vid, category: 'MESSAGE', badge: await totalUnread(),
      'interruption-level': criticalAlerts ? 'critical' : 'time-sensitive', 'relevance-score': 1,
      // critical alerts (once Apple grants the entitlement) ring through silent mode and Focus, at full volume
      ...(loud ? { sound: criticalAlerts ? { critical: 1, name: 'message-long.caf', volume: 1.0 } : 'message-long.caf' } : {}) };
    return pushAll({ aps, kind: 'message', vid }, { collapseId: undefined });
  }

  // ------------------------------------------------------------------ visitor side
  /**
   * Adds one to a counter that expires, and returns the new count.
   * @param {string} key - The counter key.
   * @param {number} ttl - Seconds until the counter expires.
   * @returns {Promise<number>} The count including this call.
   */
  const count = async (key, ttl) => (await store.update(key, '-', { add: { n: 1 }, set: { exp: sec() + ttl } })).n;
  /**
   * Handles a visitor's message: applies the rate, duplicate and bot limits, saves contact details, stores the
   * message, tells both sides, and rings the owner unless the message is suspect or the push cap is reached.
   * @param {Object} c - The visitor's connection row.
   * @param {Object} frame - The `send` frame (`text`, and optionally name, email, phone, company, lead).
   * @returns {Promise<?Object>} An error frame for the visitor, or null when the message was accepted.
   */
  async function visitorSend(c, frame) {
    const text = clean(frame.text, MAX_TEXT);
    if (!text) return { type: 'error', error: 'Type a message first.' };
    if (!c.helloAt || now() - c.helloAt < LIMITS.minHumanMs) {
      log({ event: 'chat_too_fast', vid: c.vid, ip: c.ip });
      return { type: 'error', error: 'One moment, still connecting. Try again.' };
    }
    const m = Math.floor(sec() / 60), h = Math.floor(sec() / 3600), d = Math.floor(sec() / 86400);
    if (await count('RATE#vmsg#' + c.vid + '#' + m, 120) > LIMITS.perVidMinute) return { type: 'error', error: 'Slow down a little, then try again.' };
    if (await count('RATE#vmsgh#' + c.vid + '#' + h, 7200) > LIMITS.perVidHour ||
        await count('RATE#vmsgd#' + c.vid + '#' + d, 2 * DAY) > LIMITS.perVidDay ||
        (c.ip && await count('RATE#ipmsg#' + c.ip + '#' + h, 7200) > LIMITS.perIpHour)) {
      log({ event: 'chat_rate_limited', vid: c.vid, ip: c.ip });
      return { type: 'error', error: "That's a lot of messages. I'll read what you sent; try again later." };
    }
    const existing = await store.get('CONV#' + c.vid, 'META');
    if (!existing && c.ip && await count('RATE#ipconv#' + c.ip + '#' + d, 2 * DAY) > LIMITS.newConvsPerIpDay) {
      log({ event: 'chat_new_conv_limited', vid: c.vid, ip: c.ip });
      return { type: 'error', error: 'Too many new chats from your network today. Try again tomorrow.' };
    }
    const digest = crypto.createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
    if (!(await once('DUP#' + c.vid + '#' + digest, LIMITS.dupWindowS))) return { type: 'error', error: 'You already sent that.' };
    const links = (text.match(/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ru|xyz|top|info|biz)\b/gi) || []).length;
    const suspect = links > LIMITS.maxLinks || !!c.botish;
    const set = { ...(await enrich(c.vid)), ...(suspect ? { suspect: true } : {}) };
    const name = clean(frame.name, 80), email = clean(frame.email, 160);
    if (name) set.name = name;
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) set.email = email;
    const phone = clean(frame.phone, 40), company = clean(frame.company, 120), lead = clean(frame.lead, 60);
    if (phone && phone.replace(/\D/g, '').length >= 7) set.phone = phone;
    if (company) set.company = company;
    if (lead) { set.lead = lead; set.leadAt = now(); }
    if (c.ip) set.ip = c.ip;
    const contact = Object.fromEntries(['name', 'email', 'phone', 'company', 'lead'].filter(k => set[k]).map(k => [k, set[k]]));
    if (Object.keys(contact).length && c.persist) {      // remembered visitors only
      try { await updateProfile(c.vid, contact); } catch (e) { log({ event: 'profile_update_failed', vid: c.vid, error: String(e.message || e).slice(0, 200) }); }
    }
    const { message, conv } = await addMessage(c.vid, 'visitor', text, { page: c.page, set });
    const out = convOut(conv, true);
    await toVisitor(c.vid, { type: 'message', message });
    await toOwners({ type: 'message', vid: c.vid, message, conversation: out });
    if (suspect) { log({ event: 'chat_suspect', vid: c.vid, ip: c.ip, links }); return null; }
    if (await count('RATE#msgpush#' + h, 7200) > LIMITS.msgPushesPerHour) { log({ event: 'chat_push_capped', vid: c.vid }); return null; }
    await messagePush(c.vid, out, text);
    await schedule({ kind: 'remind', vid: c.vid, at: message.at, n: 1 }, LIMITS.remindEveryS);
    return null;
  }

  /**
   * Relays the visitor's draft to the owner, live (a "sneak peek", disclosed under the widget's message box). Not stored.
   * When someone starts typing, the phone rings like a message: at most once per 5 minutes per visitor, and only
   * after the socket said hello and the wait that a first message needs too.
   * @param {Object} c - The visitor's connection row.
   * @param {Object} f - The `typing` frame; `text` is the draft when present.
   * @returns {Promise<null>} Always null: nothing is sent back to the visitor.
   */
  async function visitorTyping(c, f) {
    if (await count('RATE#vtyping#' + c.vid + '#' + Math.floor(sec() / 60), 120) > LIMITS.typingPerMinute) return null;
    const text = typeof f.text === 'string' ? clean(f.text, MAX_TEXT) : null;
    await toOwners({ type: 'typing', vid: c.vid, ...(text !== null ? { text } : {}) });
    if (!text || c.botish) return null;
    // the same proof of a person as for a first message (visitorSend): without it a script could ring the phone at will
    if (!c.helloAt || now() - c.helloAt < LIMITS.minHumanMs) return null;
    const conv = await store.get('CONV#' + c.vid, 'META');
    if (conv && (conv.blocked || conv.suspect)) return null;
    if (!(await once('THR#typingpush#' + c.vid, LIMITS.typingPushEveryS))) return null;
    if (await count('RATE#msgpush#' + Math.floor(sec() / 3600), 7200) > LIMITS.msgPushesPerHour) return null;
    const who = conv ? convOut(conv) : { vid: c.vid, ...(await enrich(c.vid)) };
    const name = who.name || (who.place ? `Visitor from ${who.place}` : 'A visitor');
    const aps = { alert: { title: `${name} is typing…`, body: text.slice(0, 180) }, 'thread-id': c.vid, category: 'MESSAGE',
      'interruption-level': criticalAlerts ? 'critical' : 'time-sensitive', 'relevance-score': 1,
      sound: criticalAlerts ? { critical: 1, name: 'message-long.caf', volume: 1.0 } : 'message-long.caf' };
    await pushAll({ aps, kind: 'typing', vid: c.vid }, {});
    log({ event: 'typing_push', vid: c.vid });
    return null;
  }

  // ------------------------------------------------------------------ owner side
  /**
   * Sends the owner's reply: by email for an email conversation, optionally also by email for a chat visitor
   * who left an address, then stores it and tells both sides.
   * @param {string} vid - Visitor id.
   * @param {string} textIn - The reply text.
   * @param {Object} [opts] - Options.
   * @param {boolean} [opts.email] - Also email the reply to a chat visitor.
   * @returns {Promise<Object>} `{message}` on success, or `{error, status}` when the reply was not sent.
   */
  async function ownerSend(vid, textIn, opts = {}) {
    if (!ID_RE.test(vid || '')) return { error: 'Unknown visitor.', status: 400 };
    const text = clean(textIn, MAX_TEXT);
    if (!text) return { error: 'Type a message first.', status: 400 };
    const before = await store.get('CONV#' + vid, 'META');
    if (before && before.channel === 'email' && before.email) {
      try {
        await sendEmail({ to: before.email, subject: /^re:/i.test(before.subject || '') ? before.subject : 'Re: ' + (before.subject || 'your message'),
          text, inReplyTo: before.mailId || '' });
      } catch (e) {
        log({ event: 'email_reply_failed', vid, error: String(e.message || e).slice(0, 200) });
        return { error: 'Could not send the email reply: ' + String(e.message || e).slice(0, 120), status: 502 };
      }
    }
    // a chat visitor who left their email can get the reply by email too (the checkbox in the app and the inbox)
    let emailed = false;
    if (opts.email && before && before.channel !== 'email') {
      if (!before.email) return { error: 'This visitor did not leave an email address.', status: 400 };
      try {
        await sendEmail({ to: before.email, subject: `${ownerName} replied to your message`,
          text: text + (siteUrl ? `\n\nYou wrote to me on ${siteHost}. Reply to this email, or carry on the chat on the site:\n${siteUrl}/#chat` : '') });
        emailed = true;
      } catch (e) {
        log({ event: 'email_reply_failed', vid, error: String(e.message || e).slice(0, 200) });
        return { error: 'Not sent: the email could not go out (' + String(e.message || e).slice(0, 120) + ').', status: 502 };
      }
    }
    const { message, conv } = await addMessage(vid, 'owner', text, { set: before ? {} : await enrich(vid) });
    if (emailed) { message.emailed = true; await store.update('CONV#' + vid, 'META', { set: { lastEmailedAt: now() } }); }
    await toVisitor(vid, { type: 'message', message });
    await toOwners({ type: 'message', vid, message, conversation: convOut(conv, (await visitorConns(vid)).length > 0) });
    return { message };
  }
  /**
   * Marks a conversation read and tells the visitor and the owner's other sockets.
   * @param {string} vid - Visitor id.
   * @returns {Promise<void>}
   */
  async function ownerRead(vid) {
    if (!(await store.get('CONV#' + vid, 'META'))) return;
    await store.update('CONV#' + vid, 'META', { set: { unread: 0, readAt: now() } });
    await toVisitor(vid, { type: 'read', at: now() });
    await toOwners({ type: 'read', vid, at: now() });
  }

  // ------------------------------------------------------------------ WebSocket
  /**
   * Accepts or refuses a new socket. The owner needs a valid session or ticket; a visitor needs a well-formed id
   * that is not an email conversation's id, a non-bot user agent and an allowed origin.
   * @param {Object} args - Connection details.
   * @param {string} args.connId - Connection id.
   * @param {Object} [args.query] - Query parameters (role, ticket, vid, sid, page, persist, me, ref).
   * @param {Object} [args.headers] - Lowercased request headers.
   * @param {string} [args.ip] - The caller's address.
   * @returns {Promise<number>} The HTTP status for the handshake: 200, 400, 401 or 403.
   */
  async function wsConnect({ connId, query = {}, headers = {}, ip = '' }) {
    if (query.role === 'owner') {
      const s = ownerFrom({ headers, ticket: query.ticket }, await sessionKey(), allowedEmail, now());
      if (!s) { log({ event: 'owner_ws_refused', ip }); return 401; }
      await store.put({ pk: 'CONN#' + connId, sk: 'META', role: 'owner', at: now(), exp: sec() + DAY });
      await store.put({ pk: 'OWNERS', sk: connId, exp: sec() + DAY });
      return 200;
    }
    const vid = query.vid, sid = query.sid || '';
    if (!ID_RE.test(vid || '') || EMAIL_VID_RE.test(vid) || (sid && !ID_RE.test(sid))) return 400;
    const ua = String(headers['user-agent'] || '');
    if (BOT_UA.test(ua)) { log({ event: 'chat_bot_refused', ip, ua: ua.slice(0, 120) }); return 403; }
    if (allowedOrigins.length && !allowedOrigins.includes(String(headers.origin || ''))) {
      log({ event: 'chat_origin_refused', ip, origin: String(headers.origin || '').slice(0, 120) }); return 403;
    }
    const page = clean(query.page, 300) || '/';
    await store.put({ pk: 'CONN#' + connId, sk: 'META', role: 'visitor', vid, sid, page, ip, persist: query.persist === '1', at: now(), exp: sec() + DAY,
                      botish: /HeadlessChrome|Lighthouse|bot/i.test(ua), me: query.me === '1', device: deviceFrom(ua), ref: clean(query.ref, 300) });
    await store.put({ pk: 'VCONN#' + vid, sk: connId, exp: sec() + DAY });
    await store.put({ pk: 'VCONNS', sk: connId, vid, exp: sec() + DAY });
    const conv = await conversation(vid);
    await toOwners({ type: 'visitor', event: 'online', vid, page, at: now(), conversation: conv, ...(conv ? {} : { visitor: await enrich(vid) }) });
    return 200;
  }

  /**
   * Forgets a closed socket and tells the owner when a visitor's last socket closed.
   * @param {string} connId - Connection id.
   * @returns {Promise<void>}
   */
  async function wsDisconnect(connId) {
    const c = await dropConn(connId);
    if (c && c.role === 'visitor' && (await visitorConns(c.vid)).length === 0) {
      await toOwners({ type: 'visitor', event: 'offline', vid: c.vid, page: c.page, conversation: await conversation(c.vid) });
    }
  }

  /**
   * Handles one frame from a socket. Answers (hello, errors) go back on the same socket.
   * @param {string} connId - Connection id.
   * @param {string} body - The frame as JSON text.
   * @returns {Promise<?Object>} The reply that was sent back, or null.
   */
  async function wsMessage(connId, body) {
    const reply = await frame(connId, body);
    if (reply) await sendTo([connId], reply);
    return reply;
  }
  /**
   * Parses a frame and carries out its action for the owner (send, typing, read) or a visitor
   * (hello, send, typing, page, read).
   * @param {string} connId - Connection id.
   * @param {string} body - The frame as JSON text.
   * @returns {Promise<?Object>} A reply frame, or null when there is nothing to answer.
   */
  async function frame(connId, body) {
    const c = await store.get('CONN#' + connId, 'META');
    if (!c) return { type: 'error', error: 'Reconnect, please.' };
    if (typeof body === 'string' && body.length > 8000) return { type: 'error', error: 'Too long.' };
    let f; try { f = JSON.parse(body || '{}'); } catch { return { type: 'error', error: 'Bad frame.' }; }
    if (c.role === 'owner') {
      if (f.action === 'send') { const r = await ownerSend(f.vid, f.text, { email: f.email === true }); return r.error ? { type: 'error', error: r.error } : null; }
      if (f.action === 'typing' && ID_RE.test(f.vid || '')) { await toVisitor(f.vid, { type: 'typing' }); return null; }
      if (f.action === 'read' && ID_RE.test(f.vid || '')) { await ownerRead(f.vid); return null; }
      return null;
    }
    if (f.action === 'hello') {
      if (!c.helloAt) {
        await store.update('CONN#' + connId, 'META', { set: { helloAt: now() } });
        await arrived(c).catch(e => log({ event: 'visit_failed', vid: c.vid, error: String(e.message || e).slice(0, 200) }));
      }
      const s = await settings();
      return { type: 'hello', online: !!s.available, greeting: s.greeting, messages: await messages(c.vid) };
    }
    if (f.action === 'send') return visitorSend(c, f);
    if (f.action === 'typing') return visitorTyping(c, f);
    if (f.action === 'page') {
      const page = clean(f.page, 300) || '/';
      await store.update('CONN#' + connId, 'META', { set: { page } });
      await toOwners({ type: 'visitor', event: 'page', vid: c.vid, page, conversation: await conversation(c.vid) });
      return null;
    }
    if (f.action === 'read') { await store.update('CONV#' + c.vid, 'META', { set: { visitorReadAt: now() } }); return null; }
    return null;
  }

  // ------------------------------------------------------------------ visits
  /**
   * Records a visit. The widget's first hello on a page is the visit. Tabs and page loads within 30 minutes are one visit.
   * Bots and the owner's own devices are ignored; only remembered visitors get a profile update.
   * @param {Object} c - The visitor's connection row.
   * @returns {Promise<?Object>} The result of `visit`, or null when nothing was announced.
   */
  async function arrived(c) {
    if (c.botish || c.me) return null;
    /**
     * Builds the profile's recent-pages field with the current page in front.
     * @param {?Object} p - The existing profile.
     * @returns {Promise<{pages: string[]}>} The field to set.
     */
    const pages = async p => ({ pages: recent(p?.pages, c.page, 20) });
    if (!(await once('THR#seen#' + c.vid, VISIT_PUSH_EVERY_S))) {
      if (c.persist) { const p = await profile(c.vid); if (p) await store.update('VISITOR#' + c.vid, 'META', { set: await pages(p) }); }
      return null;
    }
    let visits = 1;
    if (c.persist) {                                       // opted-out visitors leave nothing behind but their chat
      const p = await profile(c.vid);
      const row = await store.update('VISITOR#' + c.vid, 'META', { add: { visits: 1 }, setIfMissing: { first: sec() },
        set: { last: sec(), exp: sec() + 400 * DAY, ...(await pages(p)), devs: recent(p?.devs, c.device, 3), ips: recent(p?.ips, c.ip, 5), refs: recent(p?.refs, c.ref, 5) } });
      visits = row.visits;
      if (await store.get('CONV#' + c.vid, 'META')) await store.update('CONV#' + c.vid, 'META', { set: { visits, device: c.device } });
    }
    return visit({ vid: c.vid, visits, device: c.device, page: c.page, ref: c.ref });
  }
  /**
   * Announces a visit to the owner's phone when settings, blocking and the throttles allow it.
   * @param {Object} v - The visit: `vid` or `sid`, and optionally visits, place, device, page, ref, bot.
   * @returns {Promise<{pushed: number, why: (string|undefined)}>} How many devices were pushed, and why not when none.
   */
  async function visit(v) {
    if (!v || v.bot) return { pushed: 0, why: 'bot' };
    const key = ID_RE.test(v.vid || '') ? v.vid : ID_RE.test(v.sid || '') ? v.sid : null;
    if (!key) return { pushed: 0, why: 'no id' };
    const s = await settings();
    const visits = Number(v.visits) || 1;
    if (s.visitPings === 'off' || (s.visitPings === 'returning' && visits < 2)) return { pushed: 0, why: 'settings' };
    const conv = v.vid ? await store.get('CONV#' + v.vid, 'META') : null;
    if (conv && conv.blocked) return { pushed: 0, why: 'blocked' };
    if (!(await once('THR#visit#' + key, VISIT_PUSH_EVERY_S))) return { pushed: 0, why: 'recent' };
    const hour = await store.update('RATE#visitpush#' + Math.floor(sec() / 3600), '-', { add: { n: 1 }, set: { exp: sec() + 7200 } });
    if (hour.n > VISIT_PUSH_PER_HOUR) return { pushed: 0, why: 'hourly cap' };
    const title = visits > 1 ? `Returning visitor · ${ordinal(visits)} visit` : 'New visitor';
    const from = v.ref ? (() => { try { return new URL(v.ref).hostname.replace(/^www\./, ''); } catch { return ''; } })() : '';
    const body = [conv?.name, clean(v.place, 80), clean(v.device, 60), clean(v.page, 120) || '/', from && from !== siteHost ? 'from ' + from : '']
      .filter(Boolean).join(' · ');
    const aps = { alert: { title, body }, sound: 'visit.caf', 'thread-id': 'visits', category: 'VISIT',
      'interruption-level': 'active', 'relevance-score': 0.2 };
    return { pushed: await pushAll({ aps, kind: 'visit', vid: v.vid || '' }, { collapseId: 'visit-' + key.slice(0, 40) }) };
  }

  // ------------------------------------------------------------------ reminders: ring until answered
  /**
   * Rings again for an unanswered chat. A chat is answered once you read it (unread back to 0) or reply after
   * the message. Each reminder schedules the next.
   * @param {Object} job - `{vid, at, n}`: the visitor, the message time and the reminder number.
   * @returns {Promise<{rang: boolean, why: (string|undefined), sent: (number|undefined)}>} Whether it rang, and why not.
   */
  async function remind(job) {
    if (!job || !ID_RE.test(job.vid || '')) return { rang: false, why: 'bad job' };
    const c = await store.get('CONV#' + job.vid, 'META');
    if (!c || c.blocked || c.suspect) return { rang: false, why: 'gone, blocked or suspect' };
    if (!(c.unread > 0) || (c.readAt || 0) >= job.at) return { rang: false, why: 'read' };
    if (c.lastFrom === 'owner' && c.lastAt > job.at) return { rang: false, why: 'answered' };
    if (job.n > LIMITS.reminders) return { rang: false, why: 'gave up' };
    if (!(await once('REMIND#' + job.vid + '#' + job.at + '#' + job.n, 3600))) return { rang: false, why: 'duplicate' };   // SQS may deliver twice
    const sent = await messagePush(job.vid, convOut(c), c.lastText || 'New message', { reminder: job.n });
    if (job.n < LIMITS.reminders) await schedule({ ...job, n: job.n + 1 }, LIMITS.remindEveryS);
    log({ event: 'chat_reminder', vid: job.vid, n: job.n, sent });
    return { rang: true, sent };
  }

  // ------------------------------------------------------------------ email to the inbox address (optional, see docs/deploy.md)
  /**
   * Stores an incoming email as a chat message. Each sender is one conversation (id from their address), in the
   * same inbox as chats, with the same alerts.
   * @param {Object} m - The parsed email (`from`, `name`, `subject`, `text`, `messageId`, `spam`, `virus`).
   * @returns {Promise<Object>} `{stored: false, why}` when dropped, or `{stored: true, vid, rang}`.
   */
  async function email(m) {
    const from = String(m.from || '').toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) return { stored: false, why: 'no sender' };
    if (m.spam || m.virus) { log({ event: 'email_dropped', why: m.virus ? 'virus' : 'spam' }); return { stored: false, why: 'spam' }; }
    if (/^(mailer-daemon|postmaster|no-?reply|bounce)/i.test(from)) return { stored: false, why: 'automated sender' };
    const vid = 'em' + crypto.createHash('sha256').update(from).digest('hex').slice(0, 24);
    if (await count('RATE#email#' + vid + '#' + Math.floor(sec() / 3600), 7200) > LIMITS.emailsPerSenderHour) return { stored: false, why: 'rate' };
    const subject = clean(m.subject, 200), body = clean(m.text, MAX_TEXT);
    const text = clean((subject ? subject + '\n\n' : '') + (body || '(no text)'), MAX_TEXT);
    const set = { channel: 'email', email: from, subject, ...(m.messageId ? { mailId: clean(m.messageId, 300) } : {}), ...(m.name ? { name: clean(m.name, 80) } : {}) };
    const { message, conv } = await addMessage(vid, 'visitor', text, { set });
    const out = convOut(conv, false);
    await toOwners({ type: 'message', vid, message, conversation: out });
    if (conv.blocked) return { stored: true, vid, rang: false };
    if (await count('RATE#msgpush#' + Math.floor(sec() / 3600), 7200) > LIMITS.msgPushesPerHour) return { stored: true, vid, rang: false };
    await messagePush(vid, out, text);
    await schedule({ kind: 'remind', vid, at: message.at, n: 1 }, LIMITS.remindEveryS);
    return { stored: true, vid, rang: true };
  }

  // ------------------------------------------------------------------ owner HTTP (/owner/*)
  /**
   * The owner's HTTP API (/owner/*): conversations, messages, read, block, online visitors, visitor profile,
   * settings, devices, socket tickets and test pushes.
   * @param {Object} req - The request.
   * @param {string} req.method - HTTP method.
   * @param {string} req.path - Request path.
   * @param {Object} [req.query] - Query parameters.
   * @param {Object} [req.headers] - Request headers.
   * @param {string[]} [req.cookies] - Request cookies.
   * @param {string} [req.body] - JSON body text.
   * @returns {Promise<{status: number, body: Object}>} The status and JSON body; 401 without a valid owner session.
   */
  async function http({ method, path, query = {}, headers = {}, cookies = [], body }) {
    /**
     * Builds a response.
     * @param {number} status - HTTP status.
     * @param {Object} obj - The JSON body.
     * @returns {{status: number, body: Object}} The response.
     */
    const json = (status, obj) => ({ status, body: obj });
    const s = ownerFrom({ headers, cookies }, await sessionKey(), allowedEmail, now());
    if (!s) return json(401, { error: 'sign in' });
    const viaCookie = !String(headers.authorization || '').startsWith('Bearer ');
    if (method !== 'GET' && viaCookie && !isJson(headers['content-type'])) {
      return json(415, { error: 'Send JSON.' });        // a cross-site form can't send JSON without a preflight
    }
    let b = {};
    if (body) { try { b = JSON.parse(body); } catch { return json(400, { error: 'Send JSON.' }); } }
    let seg;
    try { seg = path.replace(/^\/owner\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); }
    catch { return json(400, { error: 'Unknown address.' }); }           // a malformed %-escape in the path

    if (seg[0] === 'conversations' && seg.length === 1 && method === 'GET') {
      const rows = await store.byLast({ limit: Math.min(Number(query.limit) || 50, 200), before: query.before ? Number(query.before) : undefined });
      const online = await Promise.all(rows.map(async r => (await visitorConns(r.vid)).length > 0));
      return json(200, { conversations: rows.map((r, i) => convOut(r, online[i])) });
    }
    if (seg[0] === 'conversations' && seg[1]) {
      const vid = seg[1];
      if (!ID_RE.test(vid)) return json(400, { error: 'Unknown visitor.' });
      if (seg[2] === 'messages' && method === 'GET') return json(200, { messages: await messages(vid, { limit: Number(query.limit) || 100, before: query.before ? Number(query.before) : undefined }) });
      if (seg[2] === 'messages' && method === 'POST') { const r = await ownerSend(vid, b.text, { email: b.email === true }); return r.error ? json(r.status, { error: r.error }) : json(200, r); }
      if (seg[2] === 'read' && method === 'POST') { await ownerRead(vid); return json(200, { ok: true }); }
      if (seg[2] === 'block' && method === 'POST') {
        await store.update('CONV#' + vid, 'META', { set: { vid, blocked: !!b.blocked }, setIfMissing: { created: now(), lastAt: 0 } });
        return json(200, { ok: true });
      }
    }
    // who has the site open right now (a live chat socket), so the owner can start a chat with them
    if (seg[0] === 'online' && method === 'GET') {
      const byVid = new Map();
      for (const r of await store.query('VCONNS')) {
        const c = await store.get('CONN#' + r.sk, 'META');
        if (!c || c.role !== 'visitor' || c.botish) continue;
        const prev = byVid.get(c.vid);
        if (!prev || c.at > prev.at) byVid.set(c.vid, { vid: c.vid, page: c.page || '/', at: c.at, since: Math.min(c.at, prev ? prev.since : c.at) });
        else prev.since = Math.min(prev.since, c.at);
      }
      const list = [...byVid.values()].sort((a, b) => b.at - a.at).slice(0, 50);
      const out = await Promise.all(list.map(async v => {
        const conv = await store.get('CONV#' + v.vid, 'META');
        return { ...v, conversation: conv ? convOut(conv, true) : null, ...(conv ? {} : await enrich(v.vid)) };
      }));
      return json(200, { visitors: out });
    }
    // what's remembered about one visitor (the app's profile sheet)
    if (seg[0] === 'visitor' && seg[1] && method === 'GET') {
      if (!ID_RE.test(seg[1])) return json(400, { error: 'Unknown visitor.' });
      const { pk, sk, exp, ...p } = (await profile(seg[1])) || {};
      return json(200, { profile: pk ? p : null, visits: [] });
    }
    if (seg[0] === 'settings' && method === 'GET') return json(200, publicSettings(await settings()));
    if (seg[0] === 'settings' && method === 'PUT') {
      const set = {};
      if (typeof b.available === 'boolean') set.available = b.available;
      if (['all', 'returning', 'off'].includes(b.visitPings)) set.visitPings = b.visitPings;
      if (typeof b.greeting === 'string') set.greeting = clean(b.greeting, 300);
      const before = await settings();
      if (Object.keys(set).length) await store.update('SETTINGS', 'META', { set });   // DynamoDB refuses an empty update
      const after = await settings();
      if (after.available !== before.available) {
        await sendTo((await store.query('VCONNS')).map(r => r.sk), { type: 'presence', online: !!after.available });
      }
      return json(200, publicSettings(after));
    }
    if (seg[0] === 'devices' && method === 'POST') {
      if (!/^[0-9a-fA-F]{32,200}$/.test(b.token || '')) return json(400, { error: 'Not an APNs device token.' });
      await store.put({ pk: 'DEVICE', sk: b.token.toLowerCase(), env: b.env === 'production' ? 'production' : 'sandbox', name: clean(b.name, 80), at: now() });
      return json(200, { ok: true });
    }
    if (seg[0] === 'devices' && seg[1] && method === 'DELETE') { await store.del('DEVICE', seg[1].toLowerCase()); return json(200, { ok: true }); }
    if (seg[0] === 'ticket' && method === 'POST') {
      return json(200, { ticket: sign({ e: s.e, k: 'ws', exp: sec() + 60 }, await sessionKey()), ws: wsUrl });
    }
    if (seg[0] === 'test-push' && method === 'POST') {
      if (b.kind === 'message') {
        return json(200, { sent: await messagePush('testvisitor0', { name: 'Test visitor' }, 'This is what a new chat sounds like. It rings until you answer.', { force: true }) });
      }
      const aps = { alert: { title: 'New visitor', body: 'Phone · iOS · Safari · / (test)' }, sound: 'visit.caf', 'thread-id': 'visits', category: 'VISIT', 'interruption-level': 'active' };
      return json(200, { sent: await pushAll({ aps, kind: 'visit', vid: '' }, {}) });
    }
    return json(400, { error: 'Unknown address.' });
  }

  // ------------------------------------------------------------------ the visitor's own data (docs/chat-protocol.md, "Your data")
  /**
   * Collects everything stored under a visitor id. Anyone holding a visitor id (the random wm_vid in that browser)
   * can see and delete what is stored under it.
   * @param {string} vid - Visitor id.
   * @returns {Promise<?Object>} The conversation, messages, profile and open-window count, or null for a malformed id.
   */
  async function visitorData(vid) {
    if (!ID_RE.test(vid || '')) return null;
    const conv = await store.get('CONV#' + vid, 'META');
    const rows = await store.query('CONV#' + vid, { prefix: 'MSG#', limit: 100000 });
    const { pk, sk, exp, ...prof } = (await profile(vid)) || {};
    let c = null;
    if (conv) { const { online, unread, blocked, suspect, ...rest } = convOut(conv); c = { ...rest, started: conv.created || null }; }
    return {
      vid, owner: ownerName, conversation: c, messages: rows.map(msgOut).map(({ vid: _v, id, ...m }) => m),   // from: 'visitor' | 'owner', at: ms
      visitor: pk ? prof : null, openChatWindows: (await visitorConns(vid)).length,
      notListed: 'Short-lived counters used against spam (up to 2 days, keyed by your network address) and a 10-minute duplicate check. They hold no message text and expire on their own.',
    };
  }
  /**
   * Deletes everything stored under a visitor id: conversation, messages, profile, throttles and connections.
   * @param {string} vid - Visitor id.
   * @returns {Promise<?{deleted: number}>} How many rows were deleted, or null for a malformed id.
   */
  async function forgetVisitor(vid) {
    if (!ID_RE.test(vid || '')) return null;
    let deleted = 0;
    /**
     * Deletes a row and counts it.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @returns {Promise<void>}
     */
    const del = async (pk, sk) => { await store.del(pk, sk); deleted++; };
    for (const r of await store.query('CONV#' + vid, { limit: 100000 })) await del(r.pk, r.sk);   // the conversation and every message
    if (await profile(vid)) await del('VISITOR#' + vid, 'META');
    for (const k of ['THR#seen#', 'THR#visit#', 'THR#msgsound#', 'THR#typingpush#']) if (await store.get(k + vid, '-')) await del(k + vid, '-');
    for (const id of await visitorConns(vid)) { await del('CONN#' + id, 'META'); await del('VCONNS', id); await del('VCONN#' + vid, id); }
    await toOwners({ type: 'forgotten', vid });
    log({ event: 'visitor_forgotten', deleted });      // no id in the log: it is the thing being forgotten
    return { deleted };
  }
  /**
   * The visitor's own-data endpoints: POST /visitor/data and /visitor/forget, body {"vid": "..."}, from the
   * sites in ALLOWED_ORIGINS only (CORS).
   * @param {Object} req - The request.
   * @param {string} req.method - HTTP method.
   * @param {string} req.path - Request path.
   * @param {Object} [req.headers] - Lowercased request headers.
   * @param {string} [req.body=''] - JSON body text.
   * @param {string} [req.ip=''] - The caller's address, for the rate limit.
   * @returns {Promise<{status: number, headers: Object, body: (Object|string)}>} The response with CORS headers.
   */
  async function visitorHttp({ method, path, headers = {}, body = '', ip = '' }) {
    const origin = String(headers.origin || '');
    const okOrigin = !allowedOrigins.length || allowedOrigins.includes(origin);
    const cors = okOrigin && origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'Origin' } : { vary: 'Origin' };
    /**
     * Builds a JSON response with the CORS headers.
     * @param {number} status - HTTP status.
     * @param {Object} obj - The JSON body.
     * @returns {{status: number, headers: Object, body: Object}} The response.
     */
    const out = (status, obj) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }, body: obj });
    if (!okOrigin) return out(403, { error: 'This site may not use the chat service.' });
    if (method === 'OPTIONS') return { status: 204, headers: { 'cache-control': 'no-store', ...cors }, body: '' };
    if (method !== 'POST') return out(405, { error: 'Use POST.' });
    if (!isJson(headers['content-type'])) return out(415, { error: 'Send JSON.' });
    if (ip && await count('RATE#vdata#' + ip + '#' + Math.floor(sec() / 3600), 7200) > 30) return out(429, { error: 'Too many requests. Try again in an hour.' });
    let b; try { b = JSON.parse(body || '{}'); } catch { return out(400, { error: 'Send JSON.' }); }
    if (!ID_RE.test(b.vid || '') || EMAIL_VID_RE.test(b.vid)) return out(400, { error: 'Unknown visitor id.' });
    if (path === '/visitor/data') return out(200, await visitorData(b.vid));
    if (path === '/visitor/forget') return out(200, { ok: true, ...(await forgetVisitor(b.vid)) });
    return out(404, { error: 'Unknown address.' });
  }

  return { wsConnect, wsDisconnect, wsMessage, visit, http, settings, remind, email, visitorData, forgetVisitor, visitorHttp };
}
