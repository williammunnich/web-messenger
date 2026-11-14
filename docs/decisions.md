# Decisions

Newest first. Each entry: date, what was decided, why, what was rejected.

## 2026-11-14: Generic names everywhere (no "wm" prefix)

- **Decided:** every name that began with "wm" is replaced by a generic one. Page API: `window.webMessenger` (was `wmChat`), `window.MESSENGER_CONFIG` (was `WM_CONFIG`), `window.messengerId`, `window.messengerPrivacy`, `<p id="messenger-privacy-line">`, `<link data-messenger>`. CSS: `.msgr` and `--` variables on it (was `.wmc`). Browser storage and cookies: `msgr_...` (was `wm_...`). iPhone app: folder and target `Messenger`, sign-in link scheme `webmessenger://` (was `wmchat://`).
- **Why:** the prefix was the first author's initials, left over from before this became a general project. A stranger reading `wmChat` cannot tell what it means.
- **Cost:** a breaking change for any page or deployment made from the first public commit: its script tags, stored visitor ids, sessions and the app's link scheme use the old names. Done now, one commit after the first release, so that nobody depends on them yet.
- **Also fixed:** the sign-in code cut the cookie's name off by a fixed length of 5 characters, which only worked while the name was exactly `wm_o`; it now uses the name's own length.

## 2026-11-14: One neutral default theme; every colour in one block

- **Decided:** the project ships with a single plain look (light and dark, a blue accent, the system font). Every colour of the widget is a CSS variable declared in one commented block at the top of `chat.css`; the rules below it and `chat.js` contain no colour. The defaults are written with `:where(.msgr)`, so a site's plain `.msgr { --accent: … }` rule wins wherever it sits in the page. The default avatar is an inline SVG coloured by `--avatar-bg` and `--avatar-fg` instead of an image with fixed colours. The inbox page keeps its colours in its `:root` block, and the iPhone app in `ios/Messenger/Support/Theme.swift`.
- **Why:** a site should be able to restyle the widget from its own stylesheet without editing or forking the widget's files, and a reader should find every colour in one place.
- **Embed API:** the variable names that existed before (`--font`, `--accent`, `--on-accent`, `--paper`, `--plate`, `--ink`, `--quiet`, `--line`, `--line-strong`, `--bubble`, `--bubble-line`, `--field-bg`, `--field-line`) keep their names and meaning. Added: `--online`, `--offline`, `--badge`, `--on-badge`, `--avatar-bg`, `--avatar-fg`, `--shadow`. Only the default values changed.
- **Also changed:** the `.smallprint` rule (a footer style for the page, not for the widget) moved from `chat.css` to the demo page, so the widget's stylesheet no longer styles anything outside `.msgr` except the `.linkish` buttons it creates itself.
- **Rejected:** several bundled themes (more to maintain; a site's own five lines of CSS do the same); a JavaScript theme option in `MESSENGER_CONFIG` (CSS variables already cover it and work with a strict Content-Security-Policy).

## 2026-11-14: Hardening before the code is read by strangers

- **Email conversations can't be opened as a visitor.** A conversation that came in by email has an id made from the sender's address (`em` + 24 hex digits), so the id is not a secret the way a widget's random id is. The visitor socket and `POST /visitor/data` / `/visitor/forget` now refuse ids of that shape (400). **Rejected:** changing how the id is made (existing email conversations would be orphaned).
- **JSON means JSON.** The owner API (cookie sessions) and the visitor data endpoints accepted any content type that merely contained the text `application/json`, such as `text/plain; application/json`, which a cross-site form can send without a preflight. The type must now be exactly `application/json`, with optional parameters. The session cookie's `SameSite=Lax` already blocked the cross-site case; this closes the second line of defence.
- **A typing ring needs the same proof of a person as a message.** The "is typing…" notification is only sent once the socket has said `hello` and 1.5 seconds have passed, as for a first message. Before, a script could ring the phone without that wait.
- **The app only uses plain http for the machine itself.** The iPhone app treated every host that began with `localhost` or `127.0.0.1` as the local bench and spoke http to it; it now requires exactly `localhost` or `127.0.0.1`, with an optional port.
- **A failed test stops a deploy.** `aws/deploy.sh deploy` printed "tests passed" on success but carried on silently when a test failed; it now stops.

## 2026-11-13: A contact form can send one chat message; Node's WebSocket client is refused as a bot

- **Decided:** a site's contact form may deliver a submission as ONE chat message through the ordinary visitor path: connect as a visitor, `hello`, wait 1.7 s, then `send` with every form field written into `text`, and `name`, `email`, `company`, `lead` as fields. The echo of the message is the form's proof of delivery. **No protocol change and no new endpoint**; the only setting is the site's origin in `ALLOWED_ORIGINS`.
- **Why:** one inbox; the visitor path already has the origin check, the bot check, the rate limits, the duplicate check and the link rule, so a form message is protected like a chat message.
- **Changed with it:** the bot user-agent list also refuses `node`, the user agent of Node's built-in WebSocket client. A plain Node script was let in when no origin list was set.
- **Rejected:** a new HTTP endpoint for forms; a per-site field on conversations (the first line of the text and `lead` say where a message came from); raising the 2000-character message limit (a form limits its fields instead).

## 2026-11-11: A reply shows as a preview bubble, never opens the chat

- **Decided:** when the owner writes while the visitor's chat is closed, the widget shows a small speech bubble above the launcher (photo, name, first 80 characters, dismiss ×, unread badge). Only a click opens the chat. The 4-second greeting uses the same bubble.
- **Why:** opening the panel by itself (the old behaviour) covered the page, and on phones it took the whole screen without the visitor asking.
- **Rejected:** a toast at the top of the page (far from the launcher, easy to confuse with the site's own UI); auto-opening only on desktop (inconsistent).

## 2026-11-11: The site's greeting wins over the inbox greeting

- **Decided:** `MESSENGER_CONFIG.greeting` first, then the greeting saved in the inbox, then the default.
- **Why:** the widget's header comment already promised "MESSENGER_CONFIG can override", but the server's greeting replaced it on connect. A site embedding the widget needs its own wording.

## 2026-11-11: Visitors can see and delete their data; the id goes in the body

- **Decided:** `POST /visitor/data` and `POST /visitor/forget` with `{"vid"}` as JSON, CORS limited to `ALLOWED_ORIGINS`, 30 requests an hour per address, `no-store`. Exposed to sites as `window.webMessenger.myData()` / `forget()`. Owners get a `forgotten` frame and drop the conversation (inbox and iPhone app). Lambda log retention cut from 365 to 90 days.
- **Why:** the random visitor id is the only key the visitor holds; possession of it is the proof. A body keeps it out of API Gateway and CloudFront access logs (a query string would be logged). JSON forces a preflight, so other sites can't trigger a delete with a plain form.
- **Rejected:** `GET`/`DELETE` with the id in the URL (logged); a sign-in for visitors (they have no account); deleting the short-lived spam counters by scanning the table (they hold no text and expire within 2 days; documented instead).
