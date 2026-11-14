/**
 * @file chat.js
 * Live chat bubble: the widget a site embeds. Talks to the chat service over a WebSocket (docs/chat-protocol.md).
 * Embed with one tag:  <script src="https://<your-api>/widget/chat.js" defer></script>
 * The server puts its own address in WM_CHAT_DEFAULTS. window.WM_CONFIG (set before this script) can override:
 * chatWs, apiBase, ownerName, ownerPhoto, privacyUrl, greeting. Add <p id="wm-privacy-line"></p> for the opt-out line.
 * The stable embed API (what a site may rely on) is docs/embed.md.
 * This file holds no colours: the whole look, including the default avatar, comes from the CSS variables at the top of
 * chat.css (docs/embed.md, "Theming").
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
/**
 * The whole widget, in one function so nothing but wmId, wmPrivacy and wmChat is added to the page's globals.
 * It works out who the visitor is, builds the bubble and panel, and keeps a WebSocket open to the chat service.
 */
(function () {
  "use strict";
  var DEF = window.WM_CHAT_DEFAULTS || {}, CFG = window.WM_CONFIG || {};
  var SCRIPT = document.currentScript, BASE = SCRIPT && SCRIPT.src ? SCRIPT.src.replace(/[^/]*$/, "") : "/widget/";
  var WS = CFG.chatWs || DEF.ws;

  // ---------- who this visitor is. Return visits are remembered with a random id in localStorage (wm_vid), unless the
  // visitor opts out, sends Global Privacy Control, or is in the EEA/UK/Switzerland (by time zone) and hasn't said yes.
  /**
   * localStorage that never throws (private windows, blocked storage).
   * `g(k)` returns the stored string or null; `s(k, v)` stores a string, or removes the key when `v` is null.
   */
  var LS = { g: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
             s: function (k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
  /**
   * Makes a random id of letters and digits.
   * @param {number} n - Length of the id.
   * @returns {string} The id.
   */
  function rid(n) { var a = new Uint8Array(n), c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", o = ""; crypto.getRandomValues(a); for (var i = 0; i < n; i++) o += c[a[i] % 62]; return o; }
  if (location.hash === "#me") { LS.s("wm_me", "1"); history.replaceState(null, "", location.pathname + location.search); }
  if (location.hash === "#notme") { LS.s("wm_me", null); history.replaceState(null, "", location.pathname + location.search); }
  var tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  var askFirst = /^Europe\//.test(tz) || /^Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)$/.test(tz);
  var said = LS.g("wm_remember") === "1";
  var optout = LS.g("wm_optout") === "1" || (navigator.globalPrivacyControl === true && !said);
  var persist = !optout && (!askFirst || said), vid = null;
  if (persist) { vid = LS.g("wm_vid"); if (!/^[A-Za-z0-9]{22}$/.test(vid || "")) { vid = rid(22); LS.s("wm_vid", vid); } }
  else { LS.s("wm_vid", null); try { vid = sessionStorage.getItem("wm_tvid"); if (!vid) { vid = rid(22); sessionStorage.setItem("wm_tvid", vid); } } catch (e) { vid = rid(22); } }
  var ID = window.wmId = { vid: vid, persist: persist, optout: optout, ask: askFirst && !said && !optout, me: LS.g("wm_me") === "1" };
  /** The visitor's privacy choices (docs/embed.md). Each one saves the choice and reloads the page. */
  window.wmPrivacy = {
    /**
     * Stops remembering this visitor and removes their stored id.
     * @returns {void}
     */
    optOut: function () { LS.s("wm_optout", "1"); LS.s("wm_remember", null); LS.s("wm_vid", null); location.reload(); },
    /**
     * Undoes an opt-out.
     * @returns {void}
     */
    optIn: function () { LS.s("wm_optout", null); location.reload(); },
    /**
     * Says yes to being remembered (needed where the widget asks first).
     * @returns {void}
     */
    remember: function () { LS.s("wm_optout", null); LS.s("wm_remember", "1"); location.reload(); } };

  // the visitor's own data (docs/embed.md): see it, or delete it. The vid goes in the POST body, never the address.
  var API = String(CFG.apiBase || DEF.api || (BASE.indexOf("http") === 0 ? new URL(BASE).origin : "")).replace(/\/$/, "");
  /**
   * Calls one of the visitor's own-data endpoints with this visitor's id in the POST body.
   * @param {string} path - `/visitor/data` or `/visitor/forget`.
   * @returns {Promise<Object>} The JSON answer; rejects when the address isn't known or the service answers with an error.
   */
  function visitorApi(path) {
    if (!API || !window.fetch) return Promise.reject(new Error("The chat service address isn't known (set WM_CONFIG.apiBase)."));
    return fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vid: ID.vid }),
                               credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; }); });
  }
  /**
   * Removes everything the widget stored in this browser, so the next visit starts with a new random id.
   * @returns {void}
   */
  function forgetLocally() {
    ["wm_chat_open", "wm_chat_cache", "wm_chat_draft", "wm_chat_outbox", "wm_chat_greeted", "wm_contact", "wm_v", "wm_tvid"].forEach(function (k) {
      try { sessionStorage.removeItem(k); } catch (e) {} try { localStorage.removeItem(k); } catch (e) {} });
    LS.s("wm_vid", null);                              // a fresh random id next time: nothing links back to the deleted one
  }
  /** The visitor's own data (docs/embed.md): `vid`, `apiBase`, and the two calls below. */
  window.wmChat = { vid: ID.vid, apiBase: API,
    /**
     * Fetches everything stored under this visitor's id.
     * @returns {Promise<Object>} The stored data.
     */
    myData: function () { return visitorApi("/visitor/data"); },
    /**
     * Deletes everything stored under this visitor's id, on the server and in this browser, and closes the socket.
     * @returns {Promise<Object>} The server's answer.
     */
    forget: function () { return visitorApi("/visitor/forget").then(function (j) { forgetLocally(); if (state && state.ws) try { state.ws.close(); } catch (e) {} return j; }); } };
  var state = null;

  if (!WS || !window.WebSocket) return;
  if (!document.querySelector('link[data-wm-chat]')) {
    var css = document.createElement("link"); css.rel = "stylesheet"; css.href = BASE + "chat.css"; css.setAttribute("data-wm-chat", "");
    document.head.appendChild(css);
  }

  var OWNER_NAME = CFG.ownerName || DEF.ownerName || "Support", FIRST_NAME = OWNER_NAME.split(" ")[0];
  state = { open: false, online: true, greeting: "", msgs: [], ids: {}, unread: 0, typingTimer: 0, ws: null, tries: 0,
                readAt: 0, lastTypingSent: 0, asked: false };
  try { state.open = sessionStorage.getItem("wm_chat_open") === "1"; } catch (e) {}

  /**
   * Creates an element.
   * @param {string} tag - Tag name.
   * @param {Object} [attrs] - Attributes to set; `text` sets the text content instead.
   * @param {Array<?Node>} [kids] - Children to append (empty entries are skipped).
   * @returns {HTMLElement} The element.
   */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) { if (k === "text") el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20.5l1.5-4.8A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>';
  // The default avatar. It is an inline SVG, not an image address, so that chat.css can colour it (--avatar-bg, --avatar-fg).
  var ICON_PERSON = '<svg class="wmc-avatar" viewBox="0 0 40 40" aria-hidden="true"><rect class="wmc-avatar-bg" width="40" height="40"/><circle class="wmc-avatar-fg" cx="20" cy="15" r="7"/><path class="wmc-avatar-fg" d="M6 38c1-10 7-14 14-14s13 4 14 14z"/></svg>';
  /**
   * Makes the owner's avatar: the site's photo (WM_CONFIG.ownerPhoto) when there is one, otherwise the default silhouette.
   * @param {number} px - Width and height in CSS pixels.
   * @returns {Element} An `img` or an `svg` element with the class `wmc-avatar`.
   */
  function avatar(px) {
    if (CFG.ownerPhoto) return h("img", { class: "wmc-avatar", src: CFG.ownerPhoto, alt: "", width: String(px), height: String(px) });
    var box = document.createElement("div"); box.innerHTML = ICON_PERSON;
    var svg = box.firstChild; svg.setAttribute("width", String(px)); svg.setAttribute("height", String(px));
    return svg;
  }

  // ---------- DOM
  var root = h("div", { class: "wmc", "data-open": "false" });
  var bubble = h("button", { class: "wmc-bubble", type: "button", "aria-label": "Chat with " + FIRST_NAME, "aria-expanded": "false", "data-t": "chat-bubble" });
  bubble.innerHTML = ICON_CHAT;
  var badge = h("span", { class: "wmc-badge", hidden: "" });
  bubble.appendChild(badge);
  // the preview bubble: a short line above the launcher when a message comes in while the chat is closed.
  // It never opens the chat by itself; a click on it does. The x dismisses it until the next message.
  var peekOpen = h("button", { class: "wmc-peek-open", type: "button", "data-t": "chat-peek" });
  var peekClose = h("button", { class: "wmc-peek-x", type: "button", "aria-label": "Dismiss" });
  var peek = h("div", { class: "wmc-peek", role: "status", "aria-live": "polite", hidden: "" }, [peekOpen, peekClose]);
  var label = h("button", { class: "wmc-label", type: "button", "data-t": "chat-label" });
  label.textContent = "Chat with me 👋";
  var launch = h("div", { class: "wmc-launch" }, [label, bubble]);

  var status = h("p", { class: "wmc-status" });
  var closeBtn = h("button", { class: "wmc-close", type: "button", "aria-label": "Close chat" }); closeBtn.innerHTML = ICON_X;
  peekClose.innerHTML = ICON_X;
  var head = h("div", { class: "wmc-head" }, [
    avatar(40),
    h("div", { class: "wmc-who" }, [h("p", { class: "wmc-name", text: "Hi there 👋" }), status]),
    closeBtn]);
  var list = h("div", { class: "wmc-list", role: "log", "aria-live": "polite", "aria-label": "Messages" });
  var typing = h("div", { class: "wmc-typing", hidden: "" }, [h("span"), h("span"), h("span")]);
  var nameIn = h("input", { class: "wmc-field", type: "text", placeholder: "Your name (optional)", maxlength: "80", autocomplete: "name", "aria-label": "Your name" });
  var emailIn = h("input", { class: "wmc-field", type: "email", placeholder: "Email (optional)", maxlength: "160", autocomplete: "email", "aria-label": "Your email" });
  var phoneIn = h("input", { class: "wmc-field", type: "tel", placeholder: "Phone (optional)", maxlength: "40", autocomplete: "tel", "aria-label": "Your phone number" });
  var companyIn = h("input", { class: "wmc-field", type: "text", placeholder: "Company (optional)", maxlength: "120", autocomplete: "organization", "aria-label": "Your company" });
  var leadNote = h("p", { class: "wmc-leadnote", hidden: "" });
  var fields = h("div", { class: "wmc-fields", id: "wmc-fields" }, [nameIn, emailIn, phoneIn, companyIn]);
  // a plain chat keeps the details folded away under one small line; a service inquiry opens them (and requires them)
  var moreBtn = h("button", { class: "wmc-more", type: "button", "aria-expanded": "false", "aria-controls": "wmc-fields" });
  var who = h("div", { class: "wmc-whois", hidden: "" }, [leadNote, moreBtn, fields]);
  var detailsOpen = false;
  /**
   * Shows or folds the contact fields and updates the line that toggles them. An inquiry always shows them.
   * @returns {void}
   */
  function renderDetails() {
    var open = !!state.lead || detailsOpen;
    fields.hidden = !open; moreBtn.hidden = !!state.lead;
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    var filled = [nameIn.value, emailIn.value].filter(Boolean).join(" · ");
    moreBtn.textContent = (open ? "Hide details" : filled ? "Your details: " + filled : "Add your name & email (optional)") + (open ? " ▴" : " ▾");
  }
  moreBtn.addEventListener("click", function () { detailsOpen = !detailsOpen; renderDetails(); if (detailsOpen) nameIn.focus(); });
  phoneIn.hidden = companyIn.hidden = false;           // always offered; required only for service inquiries
  // contact details are remembered in this browser (or only this tab, if the visitor opted out of being remembered)
  var CONTACT_KEY = "wm_contact", contactStore = ID.persist ? window.localStorage : window.sessionStorage;
  try { var saved = JSON.parse(contactStore.getItem(CONTACT_KEY) || "null");
    if (saved) { nameIn.value = saved.name || ""; emailIn.value = saved.email || ""; phoneIn.value = saved.phone || ""; companyIn.value = saved.company || ""; } } catch (e) {}
  var input = h("textarea", { class: "wmc-input", rows: "1", placeholder: "Write a message…", maxlength: "2000", "aria-label": "Message" });
  var send = h("button", { class: "wmc-send", type: "submit", "aria-label": "Send" }); send.innerHTML = ICON_SEND;
  var form = h("form", { class: "wmc-form" }, [who, h("div", { class: "wmc-row" }, [input, send])]);
  var note = h("p", { class: "wmc-note" });
  var panel = h("section", { class: "wmc-panel", role: "dialog", "aria-label": "Chat with " + FIRST_NAME, hidden: "" }, [head, list, typing, form, note]);
  root.appendChild(panel); root.appendChild(peek); root.appendChild(launch);
  document.body.appendChild(root);

  note.textContent = (ID.persist ? "This chat is saved so you can come back to it. " : "This chat lasts until you close the tab. ") + FIRST_NAME + " sees your message as you type. ";
  if (CFG.privacyUrl) note.appendChild(h("a", { href: CFG.privacyUrl, text: "Privacy" }));
  /**
   * Fills the site's `#wm-privacy-line` element, if there is one, with the opt-out line and its buttons.
   * @returns {void}
   */
  function privacyLine() {
    var el = document.getElementById("wm-privacy-line"); if (!el) return; el.textContent = "";
    /**
     * Makes a link-like button.
     * @param {string} t - The button text.
     * @param {function} f - What a click does.
     * @returns {HTMLElement} The button.
     */
    function a(t, f) { var b = h("button", { type: "button", class: "linkish", text: t }); b.addEventListener("click", f); return b; }
    /**
     * Appends plain text to the privacy line.
     * @param {string} s - The text.
     * @returns {void}
     */
    function t(s) { el.appendChild(document.createTextNode(s)); }
    if (ID.optout) { t("You opted out: this site doesn't remember you. "); el.appendChild(a("Undo", wmPrivacy.optIn)); }
    else if (ID.ask) { t("This site can remember your return visits so I can say hi. "); el.appendChild(a("Remember me", wmPrivacy.remember)); t(" · "); el.appendChild(a("Opt out", wmPrivacy.optOut)); }
    else { t("This site remembers return visits so I can say hi. "); el.appendChild(a("Opt out", wmPrivacy.optOut)); }
    if (CFG.privacyUrl) { t(" · "); el.appendChild(h("a", { href: CFG.privacyUrl, text: "Privacy" })); }
    if (ID.me) t(" · this browser is marked as the owner's (visits aren't announced)");
  }
  privacyLine();

  // ---------- rendering
  /**
   * Formats a timestamp as a short local time.
   * @param {number} ms - The time in milliseconds.
   * @returns {string} For example "3:07 PM"; empty when formatting fails.
   */
  function fmtTime(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  /**
   * Updates the status line under the owner's name (connecting, online, or leave a message) and whether the
   * contact block is shown.
   * @returns {void}
   */
  function renderStatus() {
    status.textContent = OWNER_NAME + (state.offline ? " · connecting… you can still write"
      : state.online ? " · online now" : " · leave a message and your email");
    root.setAttribute("data-online", state.online && !state.offline ? "true" : "false");
    var hasVisitorMsg = state.msgs.some(function (m) { return m.from === "visitor"; });
    who.hidden = state.lead ? false : hasVisitorMsg && !!(emailIn.value || state.asked);
    renderDetails();
  }
  /**
   * Adds a message to the list, once per id. A new message from the owner counts as unread and, with the chat
   * closed, shows as a preview bubble; it never opens the chat.
   * @param {Object} m - The message (`id`, `from`, `text`, `at`, and `pending` for one not sent yet).
   * @param {boolean} [quiet] - True for history and the visitor's own messages: no unread count or preview.
   * @returns {boolean} False when the message was already shown.
   */
  function addMsg(m, quiet) {
    if (m.id && state.ids[m.id]) return false;
    if (m.id) state.ids[m.id] = 1;
    state.msgs.push(m);
    var row = h("div", { class: "wmc-msg wmc-" + (m.from === "owner" ? "them" : "me") + (m.pending ? " wmc-pending" : "") }, [
      h("p", { class: "wmc-text", text: m.text }),
      h("time", { text: m.at ? fmtTime(m.at) : "" })]);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    if (m.from === "owner" && !quiet) {
      typing.hidden = true;
      // a message from the owner never opens the chat: closed, it shows as a small preview bubble above the launcher.
      // Silent for visitors: sounds are only for the owner, in the app.
      if (!state.open || document.hidden) { state.unread++; if (document.hidden) titleAlert(); }
      if (!state.open) { showPeek(m.text, true); label.hidden = true; }
      else if (!document.hidden) sendFrame({ action: "read" });
    }
    renderBadge(); renderStatus();
    if (!m.pending) saveCache();
    return true;
  }
  /**
   * Redraws the whole message list: the greeting, then every message.
   * @returns {void}
   */
  function renderAll() {
    list.textContent = ""; state.ids = {};
    var msgs = state.msgs; state.msgs = [];
    if (state.greeting) {
      list.appendChild(h("div", { class: "wmc-msg wmc-them wmc-greet" }, [h("p", { class: "wmc-text", text: state.greeting })]));
    }
    msgs.forEach(function (m) { addMsg(m, true); });
  }
  /**
   * Updates the unread badge on the bubble and its accessible label.
   * @returns {void}
   */
  function renderBadge() {
    badge.hidden = !state.unread;
    badge.textContent = state.unread > 9 ? "9+" : String(state.unread || "");
    bubble.setAttribute("aria-label", "Chat with " + FIRST_NAME + (state.unread ? ", " + state.unread + " new" : ""));
  }
  /** Longest preview text in the preview bubble, in characters. */
  var PEEK_CHARS = 80;
  /**
   * Shortens text to one line for the preview bubble.
   * @param {string} text - The message text.
   * @returns {string} The text with whitespace collapsed, cut with an ellipsis when too long.
   */
  function preview(text) { text = String(text || "").replace(/\s+/g, " ").trim(); return text.length > PEEK_CHARS ? text.slice(0, PEEK_CHARS - 1).trimEnd() + "…" : text; }
  /**
   * Shows the preview bubble above the launcher; does nothing while the chat is open.
   * @param {string} text - The message or greeting to preview.
   * @param {boolean} fromOwner - True for a real message from the owner, false for the greeting.
   * @returns {void}
   */
  function showPeek(text, fromOwner) {
    if (state.open) return;
    peekOpen.textContent = "";
    peekOpen.appendChild(avatar(28));
    peekOpen.appendChild(h("span", { class: "wmc-peek-body" }, [
      h("span", { class: "wmc-peek-name", text: fromOwner ? FIRST_NAME : OWNER_NAME }),
      h("span", { class: "wmc-peek-text", text: preview(text) })]));
    peekOpen.setAttribute("aria-label", (fromOwner ? "New message from " + FIRST_NAME + ": " : "") + preview(text) + " (open the chat)");
    peek.hidden = false;
  }
  /**
   * Hides the preview bubble until the next message.
   * @returns {void}
   */
  function dismissPeek() { peek.hidden = true; label.hidden = state.open || state.unread > 0; }

  var baseTitle = document.title;
  /**
   * Puts the unread count in the page title while the tab is in the background.
   * @returns {void}
   */
  function titleAlert() { document.title = "(" + state.unread + ") New message · " + baseTitle; }
  /**
   * Opens or closes the chat panel and remembers the choice for this tab.
   * @param {boolean} open - True to open.
   * @param {Object} [opts] - Options.
   * @param {boolean} [opts.quiet] - Do not move focus to the message box.
   * @returns {void}
   */
  function setOpen(open, opts) {
    state.open = open;
    try { sessionStorage.setItem("wm_chat_open", open ? "1" : "0"); } catch (e) {}
    panel.hidden = !open; root.setAttribute("data-open", open ? "true" : "false");
    bubble.innerHTML = open ? ICON_X : ICON_CHAT; bubble.appendChild(badge); label.hidden = open;
    bubble.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      peek.hidden = true;
      list.scrollTop = list.scrollHeight;
      if (!(opts && opts.quiet)) setTimeout(function () { input.focus(); }, 30);
      if (!document.hidden) { state.unread = 0; sendFrame({ action: "read" }); }
      renderBadge();
    }
  }
  /**
   * Leaves inquiry mode, because a plain chat never requires details.
   * @returns {void}
   */
  function openGeneral() { if (state.lead) setLead(null); }                  // a plain chat never requires details
  bubble.addEventListener("click", function () { if (!state.open) openGeneral(); setOpen(!state.open); });
  document.addEventListener("click", function (e) {           // any link marked data-chat-open opens the chat
    var a = e.target.closest && e.target.closest("[data-chat-open]");
    if (!a || root.hidden) return;
    e.preventDefault(); setOpen(true);
    var pre = a.getAttribute("data-chat-prefill");
    if (a.getAttribute("data-lead")) setLead(a.getAttribute("data-lead")); else openGeneral();
    if (pre) { input.value = pre; grow(); setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 60); }
  });
  peekOpen.addEventListener("click", function () { openGeneral(); setOpen(true); });
  peekClose.addEventListener("click", function () { dismissPeek(); bubble.focus(); });
  label.addEventListener("click", function () { openGeneral(); setOpen(true); });
  closeBtn.addEventListener("click", function () { setOpen(false); bubble.focus(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.open) { setOpen(false); bubble.focus(); } });

  // ---------- sending
  /**
   * Fits the message box to its text, up to 120px.
   * @returns {void}
   */
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }
  [input, nameIn, emailIn, phoneIn, companyIn].forEach(function (el) { el.addEventListener("input", saveDraft); });
  input.addEventListener("input", function () {
    grow();
    // the owner sees the message as it's typed (said in the note under the chat)
    clearTimeout(state.typingSend);
    var t = Date.now(), wait = Math.max(0, 400 - (t - state.lastTypingSent));
    state.typingSend = setTimeout(function () {
      if (input.value === state.lastTypingText) return;
      state.lastTypingSent = Date.now(); state.lastTypingText = input.value;
      sendFrame({ action: "typing", text: input.value.slice(0, 2000) });
    }, wait);
  });
  input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : submit(e); } });
  form.addEventListener("submit", submit);
  /**
   * Sends the typed message with any contact details. An inquiry needs name, email and phone first. Without a
   * connection the message is kept in the outbox and sent later.
   * @param {Event} e - The submit (or Enter key) event.
   * @returns {void}
   */
  function submit(e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    var f = { action: "send", text: text };
    if (state.lead) {
      var bad = !nameIn.value.trim() ? nameIn : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailIn.value.trim()) ? emailIn
        : (phoneIn.value.replace(/\D/g, "").length < 7) ? phoneIn : null;
      if (bad) { detailsOpen = true; renderDetails(); bad.focus(); bad.classList.add("wmc-bad"); flash("Please add your name, email and phone so I can reach you."); return; }
      f.phone = phoneIn.value.trim(); f.company = companyIn.value.trim(); f.lead = state.lead;
    }
    if (nameIn.value.trim()) f.name = nameIn.value.trim();
    if (emailIn.value.trim()) f.email = emailIn.value.trim();
    if (f.name || f.email || f.phone) {
      try { contactStore.setItem(CONTACT_KEY, JSON.stringify({ name: nameIn.value.trim(), email: emailIn.value.trim(), phone: phoneIn.value.trim(), company: companyIn.value.trim() })); } catch (e) {}
    }
    state.lastTypingText = ""; clearTimeout(state.typingSend);
    if (!sendFrame(f)) {
      outbox.push(f); saveOutbox();
      addMsg({ from: "visitor", text: text, at: Date.now(), pending: true }, true);
      flash("Saved. It will send as soon as the connection is back.");
      if (!state.ws) { state.tries = 0; connect(); }
    }
    if (f.name || f.email) state.asked = true;
    if (state.lead) setLead(null);
    input.value = ""; grow(); saveDraft();
  }
  /**
   * Turns inquiry mode on or off: an inquiry asks for contact details and makes them required.
   * @param {?string} lead - The inquiry's subject (from `data-lead`), or null for a plain chat.
   * @returns {void}
   */
  function setLead(lead) {
    state.lead = lead;
    phoneIn.required = nameIn.required = emailIn.required = !!lead;
    nameIn.placeholder = lead ? "Your name *" : "Your name (optional)";
    emailIn.placeholder = lead ? "Email *" : "Email (optional)";
    phoneIn.placeholder = lead ? "Phone *" : "Phone (optional)";
    companyIn.placeholder = "Company (optional)";
    leadNote.hidden = !lead;
    leadNote.textContent = lead ? "About " + (lead === "Project" ? "your project" : lead.toLowerCase()) + ": how can I reach you?" : "";
    renderStatus();
  }
  [nameIn, emailIn, phoneIn].forEach(function (el) { el.addEventListener("input", function () { el.classList.remove("wmc-bad"); }); });
  var OUTBOX = "wm_chat_outbox", outbox = [];
  try { outbox = JSON.parse(sessionStorage.getItem(OUTBOX) || "[]") || []; } catch (e) { outbox = []; }
  /**
   * Saves the unsent messages for this tab.
   * @returns {void}
   */
  function saveOutbox() { try { sessionStorage.setItem(OUTBOX, JSON.stringify(outbox)); } catch (e) {} }
  /**
   * Sends the outbox in order while the socket accepts it, then removes the "pending" rows once it is empty.
   * @returns {void}
   */
  function flushOutbox() {
    while (outbox.length && sendFrame(outbox[0])) outbox.shift();
    saveOutbox();
    list.querySelectorAll(".wmc-pending").forEach(function (el) { if (!outbox.length) el.remove(); });
  }
  // one continuous chat across pages: history, draft and the inquiry form carry over (this tab; history also comes from the server)
  var CACHE = "wm_chat_cache", DRAFT = "wm_chat_draft";
  /**
   * Saves the last 100 messages for this tab, so the chat is there at once on the next page.
   * @returns {void}
   */
  function saveCache() { try { sessionStorage.setItem(CACHE, JSON.stringify(state.msgs.slice(-100))); } catch (e) {} }
  /**
   * Saves the typed text and contact fields for this tab.
   * @returns {void}
   */
  function saveDraft() {
    try { sessionStorage.setItem(DRAFT, JSON.stringify({ text: input.value, name: nameIn.value, email: emailIn.value, phone: phoneIn.value, company: companyIn.value })); } catch (e) {}
  }
  /**
   * Shows a short notice in the message list for four seconds.
   * @param {string} t - The notice.
   * @returns {void}
   */
  function flash(t) {
    var el = h("p", { class: "wmc-error", text: t });
    list.appendChild(el); list.scrollTop = list.scrollHeight;
    setTimeout(function () { el.remove(); }, 4000);
  }

  // ---------- socket
  /**
   * Sends a frame to the chat service.
   * @param {Object} f - The frame (docs/chat-protocol.md).
   * @returns {boolean} False when the socket is not open or the send failed.
   */
  function sendFrame(f) {
    if (!state.ws || state.ws.readyState !== 1) return false;
    try { state.ws.send(JSON.stringify(f)); return true; } catch (e) { return false; }
  }
  /**
   * Opens the WebSocket as this visitor and wires up its events; a failure schedules a retry.
   * @returns {void}
   */
  function connect() {
    var u = WS + "?role=visitor&vid=" + encodeURIComponent(ID.vid) + "&sid=" + encodeURIComponent(sid()) +
            "&page=" + encodeURIComponent(location.pathname) + "&persist=" + (ID.persist ? "1" : "0") + (ID.me ? "&me=1" : "") +
            (document.referrer ? "&ref=" + encodeURIComponent(document.referrer.slice(0, 300)) : "");
    var ws;
    try { ws = new WebSocket(u); } catch (e) { return retry(); }
    state.ws = ws;
    /** On connect: say hello, and send anything written while disconnected. */
    ws.onopen = function () {
      state.tries = 0; state.everConnected = true;
      if (state.offline) { state.offline = false; renderStatus(); }
      sendFrame({ action: "hello" });
      setTimeout(flushOutbox, 1700);                   // anything written while disconnected goes now (after the 1.5 s human check)
    };
    /**
     * Handles a frame from the service: hello (history and settings), message, typing, presence or error.
     * @param {MessageEvent} ev - The socket message.
     */
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "hello") {
        state.online = !!m.online; state.greeting = CFG.greeting || m.greeting || state.greeting;   // the site's own greeting wins (docs/embed.md)
        state.msgs = (m.messages || []).slice(); renderAll(); renderStatus(); saveCache();
        root.hidden = false;
        if (state.open) sendFrame({ action: "read" });
      } else if (m.type === "message" && m.message) {
        addMsg(m.message, m.message.from === "visitor");
      } else if (m.type === "typing") {
        typing.hidden = false; list.scrollTop = list.scrollHeight;
        clearTimeout(state.typingTimer); state.typingTimer = setTimeout(function () { typing.hidden = true; }, 5000);
      } else if (m.type === "presence") {
        state.online = !!m.online; renderStatus();
      } else if (m.type === "error") {
        flash(m.error || "Something went wrong.");
      }
    };
    ws.onclose = function () { state.ws = null; retry(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  /**
   * Marks the chat as not connected, so the status says the visitor can still write.
   * @returns {void}
   */
  function goOffline() {
    if (state.offline) return;
    state.offline = true; renderStatus();
  }
  /**
   * Schedules a reconnect with a growing delay (up to 30 seconds); waits for the tab to be visible.
   * @returns {void}
   */
  function retry() {
    if (state.tries >= 2 && !state.everConnected) goOffline();
    if (document.hidden) return;                       // reconnects when the tab is visible again
    var wait = Math.min(30000, 1000 * Math.pow(2, state.tries++)) + Math.random() * 500;
    setTimeout(function () { if (!state.ws) connect(); }, wait);
  }
  /**
   * Returns this tab's session id, creating it on first use.
   * @returns {string} The session id; the visitor id when sessionStorage is unavailable.
   */
  function sid() {
    try { var s = sessionStorage.getItem("wm_v"); if (!s) { s = rid(32); sessionStorage.setItem("wm_v", s); } return s; } catch (e) {}
    return ID.vid;
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !state.ws) { state.tries = 0; connect(); }
    if (!document.hidden && state.open && state.unread) { state.unread = 0; renderBadge(); sendFrame({ action: "read" }); }
    if (!document.hidden) document.title = baseTitle;
  });

  try { var cached = JSON.parse(sessionStorage.getItem(CACHE) || "[]"); if (cached.length) state.msgs = cached; } catch (e) {}
  try { var d = JSON.parse(sessionStorage.getItem(DRAFT) || "null");
    // the typed text carries over between pages; the inquiry mode never does (only a service button turns it on)
    if (d) { input.value = d.text || ""; ["name", "email", "phone", "company"].forEach(function (k) {
      var el = { name: nameIn, email: emailIn, phone: phoneIn, company: companyIn }[k]; if (d[k]) el.value = d[k]; }); } } catch (e) {}
  setOpen(state.open);
  renderStatus();
  if (!state.greeting) state.greeting = CFG.greeting || "Hi! Ask me anything.";
  renderAll();
  setTimeout(connect, 600);
  // a few seconds into a first visit this session, a one-line hello pops up with a badge
  var greeted = false; try { greeted = sessionStorage.getItem("wm_chat_greeted") === "1"; } catch (e) {}
  if (!greeted && !state.open) setTimeout(function () {
    if (state.open || state.msgs.length) return;
    try { sessionStorage.setItem("wm_chat_greeted", "1"); } catch (e) {}
    state.unread = Math.max(state.unread, 1); renderBadge(); showPeek(state.greeting, false); label.hidden = true;
  }, 4000);
})();
