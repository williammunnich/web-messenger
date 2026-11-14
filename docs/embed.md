# Embedding the widget (stable API)

updated: 2026-11-14

This page is the contract between the messenger and any site that embeds it. Everything listed here is **stable**: later versions only add to it (new optional keys, new methods, new CSS variables). Nothing here is renamed, removed or changed in meaning without a new major version and a note in [decisions.md](decisions.md). Anything not on this page (other class names, internal storage keys, frame details) may change.

## 1. Allow the site

The chat service only talks to sites listed in `ALLOWED_ORIGINS` (in your `deploy.env`, then `bash aws/deploy.sh deploy`). List exact origins, comma-separated, no paths:

```
ALLOWED_ORIGINS=https://example.com,https://www.example.com,https://second-site.example.org
```

A site that isn't listed gets its chat socket refused (403) and its `/visitor/*` calls refused (403, no CORS headers).

## 2. Add the script

```html
<script>
  window.MESSENGER_CONFIG = {                       // optional, set before the script tag
    ownerName: "Your Name",                  // shown in the header and the preview bubble
    ownerPhoto: "https://example.com/you.jpg",
    greeting: "Hi! How can I help?",         // wins over the greeting set in the inbox
    privacyUrl: "/privacy.html",             // linked under the message box and in the opt-out line
    chatWs: "wss://chat.example.com",        // only if you need another socket address than the server's own
    apiBase: "https://inbox.example.com"     // only if the script is served from somewhere other than the chat service
  };
</script>
<script src="https://YOUR-API/widget/chat.js" defer></script>
```

The script loads its own stylesheet (`chat.css`, next to it) unless the page already has a `<link data-messenger>`.

### MESSENGER_CONFIG keys

| Key | Default | Meaning |
|---|---|---|
| `ownerName` | the server's `OWNER_NAME` | Name in the chat header and preview bubble |
| `ownerPhoto` | a plain silhouette, coloured by `--avatar-bg` and `--avatar-fg` | Avatar in the header and preview bubble |
| `greeting` | the inbox setting, else "Hi! Ask me anything." | First line in the chat. **Precedence: `MESSENGER_CONFIG.greeting`, then the greeting saved in the inbox, then the default.** |
| `privacyUrl` | none | Link to your privacy page |
| `chatWs` | the server's own WebSocket address | Chat socket |
| `apiBase` | the origin the script was loaded from | Where `/visitor/data` and `/visitor/forget` are called |

## 3. Theming

The widget ships with one plain default look: light and dark, a blue accent, the system font. Every colour and the font are CSS variables on `.msgr`, all declared in one block at the top of `chat.css`. To restyle the widget, set them on `.msgr` anywhere in your own page's CSS. The order doesn't matter: the widget's defaults are written with `:where(.msgr)`, which always loses to a plain `.msgr` rule.

```html
<style>
  .msgr {
    --accent: #0f766e;  --on-accent: #ffffff;
    --paper: #fffdf8;   --plate: #f4efe6;
    --ink: #1c1917;     --quiet: #6b645c;
    --font: Georgia, "Times New Roman", serif;
  }
  @media (prefers-color-scheme: dark) {
    .msgr { --accent: #2dd4bf; --on-accent: #042f2e; --paper: #1c1917; --plate: #141210; --ink: #f1ece4; --quiet: #a8a29a; }
  }
</style>
```

| Variable | Used for |
|---|---|
| `--font` | All widget text |
| `--accent`, `--on-accent` | Launcher button, header, the visitor's own bubbles, send button, focus rings; and the text and icons on them |
| `--paper`, `--plate` | Panel and form background; message list background |
| `--ink`, `--quiet` | Text; secondary text and placeholders |
| `--line`, `--line-strong` | Thin borders; stronger borders and underlines |
| `--bubble`, `--bubble-line` | The owner's message bubbles, the preview bubble and the "Chat with me" pill; their border |
| `--field-bg`, `--field-line` | Text fields; their border |
| `--online`, `--offline` | The availability dot on the launcher |
| `--badge`, `--on-badge` | The unread badge and its number |
| `--avatar-bg`, `--avatar-fg` | The default avatar, shown when no `ownerPhoto` is set |
| `--shadow` | The colour of all drop shadows |

**Light and dark.** Light is the default; dark follows the visitor's system setting (`prefers-color-scheme: dark`). A variable you don't set keeps the widget's default for that mode, so when you change a colour, set it for both modes as in the example. If your site has no dark mode and the widget should stay light, repeat your light values inside the dark media query.

**Contrast.** `--on-accent` is drawn on `--accent`, `--ink` on `--paper`, `--plate`, `--bubble` and `--field-bg`, and `--on-badge` on `--badge`. Pick pairs that stay readable.

**What is stable.** The variable names above and what each is used for. The default values are not part of the contract: they are only the look the project ships with.

## 4. Behaviour you can count on

- **Closed chat, new reply:** a small preview bubble appears above the launcher: the owner's photo, name, and the message cut to 80 characters. It is at most 260px wide (`min(260px, 100vw - 32px)` on phones), has a dismiss ×, and never covers more of the page than that. The chat **never opens by itself** and never goes full screen by itself. Clicking the preview opens the normal chat panel; on phones (≤480px wide) the panel is full screen once opened by the visitor.
- **First visit in a tab:** after 4 seconds, the greeting shows in the same preview bubble (dismissible), with a badge of 1.
- **Unread badge** on the launcher, and `(n) New message` in the tab title while the tab is hidden.

## 5. Page hooks

| Hook | Effect |
|---|---|
| `data-chat-open` on any element | Clicking it opens the chat |
| `data-chat-prefill="text"` | …with this text in the message box |
| `data-lead="Project"` | …as an inquiry that asks for name, email and phone |
| `<p id="messenger-privacy-line"></p>` | Filled with the opt-out / remember-me line |
| `yoursite/#me`, `#notme` | Marks this browser as the owner's (not announced) or undoes it |

## 6. JavaScript API

| Global | Shape |
|---|---|
| `window.messengerId` | `{ vid, persist, optout, ask, me }`. `vid` is the random visitor id (22 letters and digits). `persist` is false when the visitor opted out, sent Global Privacy Control, or is in an ask-first time zone and hasn't said yes; the id then lasts only for the tab. |
| `window.messengerPrivacy` | `optOut()`, `optIn()`, `remember()`. Each reloads the page. |
| `window.webMessenger` | `{ vid, apiBase, myData(), forget() }` (below) |

### window.webMessenger

- `webMessenger.myData()` → `Promise<Data>`, rejects with an `Error` on failure. `Data`:

  ```js
  {
    vid: "…",
    owner: "Your Name",
    conversation: { vid, name, email, phone, company, lead, place, device, visits, channel, lastText, lastFrom, lastAt, ip, started } | null,
    messages: [{ from: "visitor" | "owner", text: "…", at: 1794460000000 /* ms */, page: "/…" /* optional */ }],
    visitor: { visits, first, last, pages, devs, ips, refs, … } | null,   // the remembered-visitor profile
    openChatWindows: 1,
    notListed: "what is kept but can't be listed by id, and for how long"
  }
  ```

- `webMessenger.forget()` → `Promise<{ ok: true, deleted: n }>`, rejects with an `Error` on failure. It deletes everything the chat service stores under the id (see [chat-protocol.md](chat-protocol.md#the-visitors-own-data-http-no-sign-in)), closes the chat socket, and clears the widget's own browser storage (`msgr_chat_*`, saved contact details and the `msgr_vid` id, so the next page load starts with a fresh id). Reload the page afterwards.

Both send the id in a JSON POST body to `apiBase + "/visitor/data"` / `"/visitor/forget"`, never in the URL. If your page has a Content Security Policy, allow `apiBase` in `connect-src`.

## Versions

| Date | Change |
|---|---|
| 2026-11-11 | First written down. Added the preview bubble (replacing auto-open), greeting precedence, `apiBase`, `window.webMessenger`. |
| 2026-11-14 | New neutral default colours (names unchanged). Added the variables `--online`, `--offline`, `--badge`, `--on-badge`, `--avatar-bg`, `--avatar-fg`, `--shadow`. The default avatar follows the theme. |
