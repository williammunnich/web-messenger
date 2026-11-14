# The contract

Everything the parts agree on: the widget (`aws/chat/src/public/chat.js`), the chat service (`aws/chat/src/`), the web inbox (`aws/chat/src/public/inbox.html`) and the iPhone app (`ios/`). Change this file first, then the code.

## Hosts

| Name | Address | What |
|---|---|---|
| HTTP | `https://<api id>.execute-api.<region>.amazonaws.com`, or your `INBOX_DOMAIN` | the owner API (`/owner/*`), sign-in, the inbox (`/`), the widget (`/widget/*`) and a demo page (`/demo`) |
| CHAT | `wss://<api id>.execute-api.<region>.amazonaws.com/prod`, or your `CHAT_DOMAIN` | the chat WebSocket. Visitors and the owner both connect here. |

The widget learns CHAT from the `WM_CHAT_DEFAULTS` line the server puts at the top of `/widget/chat.js`. The inbox and the app learn it from `POST /owner/ticket`.

## Sign-in (one Google account for the inbox and the app)

- **Inbox (web):** `GET /login` runs Google sign-in and sets the `wm_s` cookie on HTTP (12 hours). `GET /logout` clears it.
- **App:** `ASWebAuthenticationSession` opens `HTTP/app/login?state=<random 32 chars>` with callback scheme `wmchat`. That runs the same Google sign-in. On success it redirects to `wmchat://auth?token=<session>&state=<same state>`. The app checks `state`, keeps `token` in the Keychain, and sends `Authorization: Bearer <token>` on every request. App sessions last 90 days. A 401 from anything means "sign in again".
- **Session format:** `b64url(json).hex(hmac_sha256(key, b64url(json)))`. The key is the SSM SecureString `/<prefix>/session-key`. The JSON is `{"e": email, "exp": unix, "k": "web"|"app"|"ws"}`. A session is valid if the MAC matches, `exp` is in the future and `e` equals `ALLOWED_EMAIL`.
- **WebSocket ticket:** `POST HTTP/owner/ticket` returns `{"ticket": "<session with k=ws, 60 s>", "ws": "<CHAT address>"}`. The owner then connects to `CHAT?role=owner&ticket=<ticket>`.

## Visitor identity and opt-out (widget side)

- `localStorage.wm_vid`: a random 22-character id (`[A-Za-z0-9]`), kept until the visitor opts out. It's only created when remembering is allowed (see below). Otherwise the id lives in `sessionStorage` (this tab only) and is never linked to earlier visits.
- `localStorage.wm_optout = "1"` means: no `wm_vid` (it gets deleted), and chat still works anonymously for this tab. Global Privacy Control (`navigator.globalPrivacyControl === true`) counts as opted out unless the visitor clicks "remember me".
- **Remembering:** the browser decides from its own time zone, before anything is stored. It asks first when the zone is `Europe/*` or one of the Atlantic zones of the EEA, UK or Switzerland (Reykjavik, Canary, Madeira, Azores, Faroe). There, the privacy line offers "Remember me" and nothing is stored until it's clicked (it sets `localStorage.wm_remember = "1"`). Everyone else is remembered unless they opt out.
- `localStorage.wm_me = "1"` (visit `/#me` once; `/#notme` undoes it) marks the owner's own browser. Its visits are not counted or announced.
- **Visits:** the widget's first `hello` on a page counts as a visit, and page loads within 30 minutes are the same visit. For remembered visitors the service keeps a **visitor profile** for 400 days after the last visit (`pk = VISITOR#<vid>`) with `first`, `last`, `visits`, `ips` (last 5), `devs` (last 3, as "Phone · iOS · Safari"), `refs` (last 5), `pages` (last 20), and any `name`, `email`, `phone`, `company`, `lead` from the chat.
- **Privacy line:** add `<p id="wm-privacy-line"></p>` to a page and the widget fills it with the current state and an opt-out or undo button.

## Chat WebSocket (CHAT)

Connect: `CHAT?role=visitor&vid=<vid>&sid=<tab id>&page=<path>&persist=1|0&ref=<referrer>?&me=1?` (visitor), or `CHAT?role=owner&ticket=…`. Frames are JSON text. A visitor's `vid` is 8 to 40 letters and digits and must not have the shape of an email conversation's id (`em` + 24 hex digits); otherwise the handshake is refused with 400.

Visitor → server (send `hello` first, right after the socket opens: API Gateway can't send anything during `$connect`):
- `{"action":"hello"}`
- `{"action":"send","text":"…","name":"…"?,"email":"…"?}`. The text is 1–2000 chars. Name and email are optional; they're saved on the conversation.
- `{"action":"typing","text":"…"?}` (`text` is the draft so far, shown live to the owner and not stored; without `text` the owner only sees "typing…"), `{"action":"page","page":"/about"}` and `{"action":"read"}`.

Server → visitor:
- `{"type":"hello","online":bool,"greeting":"…","messages":[Message…]}`. This is the answer to `hello`; `messages` is this vid's history (the last 100).
- `{"type":"message","message":Message}`. This is sent for owner messages and as the echo of the visitor's own messages, which carry the server id and time.
- `{"type":"typing"}` (the owner is typing), `{"type":"read","at":ms}` (the owner read up to here), `{"type":"presence","online":bool}`, and `{"type":"error","error":"…"}`.

Owner → server:
- `{"action":"send","vid":"…","text":"…"}`
- `{"action":"typing","vid":"…"}`
- `{"action":"read","vid":"…"}`

Server → owner:
- `{"type":"message","vid":"…","message":Message,"conversation":Conversation}` for messages from either side, including ones sent from another owner device.
- `{"type":"visitor","event":"online"|"offline"|"page","vid":"…","page":"/…","conversation":Conversation|null}`
- `{"type":"typing","vid":"…","text":"…"?}` (`text` is the visitor's draft so far; an empty string means they cleared it), `{"type":"read","vid":"…","at":ms}`
- `{"type":"forgotten","vid":"…"}`: the visitor deleted their data (`POST /visitor/forget`). Drop the conversation, its messages and any open thread for that vid. The inbox and the iPhone app both do.

**Message:** `{"id":"m_…","vid":"…","from":"visitor"|"owner","text":"…","at":ms,"page":"/…"?}`

**Conversation:** `{"vid","name","email","lastText","lastFrom","lastAt","unread","online","place","device","visits","blocked"}`. Here `unread` counts visitor messages the owner hasn't read, and `online` means the visitor has an open socket now.

## Owner HTTP (cookie or Bearer)

With a cookie session, every request other than `GET` must be `content-type: application/json` (415 otherwise), so a form on another site can't make one.

| Method and path | Body | Returns |
|---|---|---|
| `GET /owner/conversations?limit=50&before=ms` | | `{"conversations":[Conversation…]}`, newest `lastAt` first |
| `GET /owner/conversations/{vid}/messages?limit=100&before=ms` | | `{"messages":[Message…]}`, oldest first |
| `POST /owner/conversations/{vid}/messages` | `{"text":"…"}` | `{"message":Message}`, also delivered to the visitor's open tabs |
| `POST /owner/conversations/{vid}/read` | | `{"ok":true}` |
| `POST /owner/conversations/{vid}/block` | `{"blocked":bool}` | `{"ok":true}`. A blocked visitor's messages are kept but never notify. |
| `GET /owner/settings` | | `{"available":bool,"visitPings":"all"\|"returning"\|"off","greeting":"…"}` |
| `PUT /owner/settings` | any of the fields | the settings |
| `POST /owner/devices` | `{"token":"<apns hex>","env":"sandbox"\|"production","name":"…"}` | `{"ok":true}` |
| `DELETE /owner/devices/{token}` | | `{"ok":true}` |
| `POST /owner/ticket` | | `{"ticket":"…","ws":"…"}` |
| `GET /owner/online` | | `{"visitors":[…]}`, who has the widget open now |
| `GET /owner/visitor/{vid}` | | `{"profile":Profile\|null,"visits":[]}` |
| `POST /owner/test-push` | `{"kind":"visit"\|"message"}` | `{"sent":n}` |

`available` means the bubble says "Online" and expects a reply soon. Otherwise it says "Leave a message" and asks for an email. Messages are delivered and notify either way.

## The visitor's own data (HTTP, no sign-in)

A visitor can see and delete everything stored under their visitor id. The widget calls these through `window.wmChat` ([embed.md](embed.md)).

| Method and path | Body | Returns |
|---|---|---|
| `POST /visitor/data` | `{"vid":"…"}` | `{"vid","owner","conversation":Conversation-without-unread/online/blocked/suspect\|null,"messages":[{"from":"visitor"\|"owner","text","at":ms,"page"?}],"visitor":Profile\|null,"openChatWindows":n,"notListed":"…"}` |
| `POST /visitor/forget` | `{"vid":"…"}` | `{"ok":true,"deleted":n}`. Owners get a `forgotten` frame. |
| `OPTIONS` on either | | 204 with CORS headers (preflight) |

- **The vid goes in the body, never the address,** so it doesn't land in access logs. The request must be `content-type: application/json` (the type itself, optionally followed by parameters such as a charset; a header that only contains that text, like `text/plain; application/json`, gets 415), which forces a CORS preflight from other sites.
- **Email conversations are not reachable here.** Their id is made from the sender's address (`em` + 24 hex digits), so it is not a secret. An id of that shape gets 400 on both endpoints, and the visitor socket refuses it too.
- **CORS:** only origins in `ALLOWED_ORIGINS` get `access-control-allow-origin`; any other `Origin` gets 403 and nothing happens. An empty list (the local bench) allows any origin.
- **Rate limit:** 30 requests an hour per network address (429 after that).
- **What `forget` deletes:** the whole `CONV#<vid>` partition (conversation and every message, contact details included), `VISITOR#<vid>`, the `THR#seen|visit|msgsound|typingpush#<vid>` throttles, and every open connection (`VCONN#<vid>`, its `CONN#<id>` and `VCONNS/<id>` rows). Responses are `cache-control: no-store`. The log line says how many rows went, not which visitor.
- **What it can't reach by id, and how long that lasts:** `DUP#<vid>#<hash>` duplicate checks (10 minutes), `RATE#…` counters keyed by vid or network address (at most 2 days), `REMIND#…` reminder de-duplication (1 hour). None of them hold message text; DynamoDB's TTL removes them. Lambda logs (which carry visitor ids and IP addresses in some lines) are kept 90 days. Push notifications already shown on the owner's phone and emails already sent are outside the service.

## Throttling and bots

Limits live in `aws/chat/src/service.mjs` (`LIMITS`). Messages over a limit get a polite `error` frame.

| Rule | Limit |
|---|---|
| Messages per visitor | 6 a minute, 30 an hour, 80 a day |
| Messages per network address (any visitor id) | 40 an hour |
| New conversations per network address | 5 a day |
| The same text again (case and spacing ignored) | dropped for 10 minutes |
| A first message sooner than 1.5 s after `hello` (or without `hello`) | refused ("still connecting") |
| A typing notification ("… is typing…") | at most one per visitor per 5 minutes, counted in the message notifications below, and never sooner than 1.5 s after `hello` (or without `hello`) |
| More than 2 links, or a headless browser | kept, the conversation is marked `suspect: true`, never notifies |
| Message notifications in total | 40 an hour; after that, messages are kept silently |
| Visitor sockets | refused (403) for bot user agents (curl, python, headless, crawlers, Node's built-in WebSocket client `node`, empty) and for any `Origin` other than the site |
| Visit notifications | never for bots or the owner's own browser |

Conversation also carries `suspect` (bool).

## Push notifications (APNs, token auth, sent by the chat service)

| Kind | When | `aps` |
|---|---|---|
| visit | Someone loads a page. Not for bots or when `visitPings` is "off"; "returning" means only `visits > 1`. At most one per vid per 30 minutes, and at most 30 visit pushes an hour in total. | `alert {title: "Returning visitor · 5th visit" or "New visitor", body: "Phone · iOS · Safari · /about · from google.com"}`, `sound: "visit.caf"`, `thread-id: "visits"`, `category: "VISIT"`, `interruption-level: "active"`, `relevance-score: 0.2` |
| message | A visitor sends a message. Not if they're blocked. At most one sounding push per vid per 20 seconds; extras are sent silently, with `sound` left out. | `alert {title: name or "Visitor", body: text (first 180 chars)}`, `sound: "message.caf"`, `thread-id: <vid>`, `category: "MESSAGE"`, `interruption-level: "time-sensitive"`, `badge: total unread`, `relevance-score: 1` |

Custom keys: `{"kind":"visit"|"message","vid":"…"}`.

**Two sounds.** `visit.caf` is the short ping, played once. `message-long.caf` is the chat alert: one ring repeated to about 25 seconds, the most iPhone plays.

**Ringing until answered.** After a message notification, the service queues a reminder (an SQS delay queue, 1 minute). Each reminder checks the conversation again. If it's still unread and you haven't replied, the reminder sends another loud alert titled "Still waiting · …", up to 10 reminders in all. Reading the chat (marking read, or opening it in the app or inbox) or replying stops it. Blocked and suspect chats never get reminders. While the app is open it loops the message sound until the waiting chat is opened.

Categories:
- `MESSAGE`: the action `REPLY` (`UNTextInputNotificationAction`, button "Reply", placeholder "Message"). It posts to `/owner/conversations/{vid}/messages` with the Bearer token from the Keychain (keychain access group shared with the app). The action `READ` ("Mark read") posts `/read`.
- `VISIT`: the action `SAY_HI` (foreground) opens that visitor's chat.

Sounds: `visit.caf`, `message.caf` and `message-long.caf`, in the app bundle (from `assets-src/sounds/`). The widget plays no sounds.

The app registers with `env: "sandbox"` in Debug builds (installed over the cable) and `"production"` otherwise. The chat service sends to `api.sandbox.push.apple.com` or `api.push.apple.com` accordingly. The APNs key (.p8) is kept in SSM `/<prefix>/apns-key`, with `/<prefix>/apns-key-id`, and `APNS_TEAM_ID` and `APNS_TOPIC` (the bundle id) set as environment variables.

Bundle id: your own, set in `ios/Local.xcconfig`. URL scheme: `wmchat`.
