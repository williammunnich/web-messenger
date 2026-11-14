/**
 * @file mail.mjs
 * Just enough MIME to turn an incoming email into a chat message: sender, subject, plain-text body.
 * (SES stores the raw message in S3; the chat service reads it from there.)
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

/**
 * Decodes RFC 2047 encoded words in a header value (base64 and quoted-printable forms).
 * @param {string} s - The raw header value.
 * @returns {string} The readable text; a word that cannot be decoded is left as its encoded text.
 */
function decodeWords(s) {                                     // =?utf-8?B?...?= and =?utf-8?Q?...?=
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return new TextDecoder(/utf-?8/i.test(cs) ? 'utf-8' : 'latin1').decode(buf);
    } catch { return txt; }
  });
}

/**
 * Splits a message or MIME part into headers and body. Folded header lines are joined, names are lowercased,
 * and the first occurrence of a header wins.
 * @param {string} raw - The raw message or part.
 * @returns {{headers: Object<string, string>, body: string}} The headers and the body text.
 */
function splitMessage(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i), body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const j = line.indexOf(':');
    if (j > 0) { const k = line.slice(0, j).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(j + 1).trim(); }
  }
  return { headers, body };
}

/**
 * Decodes a part's body from its transfer encoding and character set.
 * @param {string} body - The encoded body.
 * @param {string} enc - Content-Transfer-Encoding (`base64`, `quoted-printable`, or anything else for as-is).
 * @param {string} ctype - Content-Type, read for its charset (utf-8 when absent).
 * @returns {string} The decoded text.
 */
function decodeBody(body, enc, ctype) {
  enc = String(enc || '').toLowerCase();
  let buf;
  if (enc === 'base64') buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') {
    buf = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
  } else buf = Buffer.from(body, 'binary');
  const cs = /charset="?([^";\s]+)/i.exec(ctype || '')?.[1] || 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}

/**
 * Finds the readable text of a part, searching multipart messages recursively. Plain text is preferred;
 * otherwise the first HTML part is used with its tags stripped.
 * @param {{headers: Object<string, string>, body: string}} part - A part from splitMessage.
 * @returns {?{type: string, text: string}} `{type: 'text'|'html', text}`, or null when there is no text part.
 */
function findText(part) {
  const ctype = part.headers['content-type'] || 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    const pieces = part.body.split('--' + boundary).slice(1).filter(p => !p.startsWith('--'));
    let html = null;
    for (const p of pieces) {
      const sub = splitMessage(p.replace(/^\r?\n/, ''));
      const r = findText(sub);
      if (r && r.type === 'text') return r;
      if (r && r.type === 'html' && !html) html = r;
    }
    return html;
  }
  if (/^text\/plain/i.test(ctype)) return { type: 'text', text: decodeBody(part.body, part.headers['content-transfer-encoding'], ctype) };
  if (/^text\/html/i.test(ctype)) {
    const h = decodeBody(part.body, part.headers['content-transfer-encoding'], ctype);
    return { type: 'html', text: h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"') };
  }
  return null;
}

/**
 * Drops the quoted earlier conversation ("On ... wrote:" and "> " lines) so the chat shows only what's new.
 * @param {string} text - The decoded body.
 * @returns {string} The new part of the message, trimmed.
 */
function trimQuoted(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) && out.length) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parses a raw email into the fields the chat service stores.
 * @param {string} raw - The raw message.
 * @returns {{from: string, name: string, subject: string, messageId: string, text: string}} Sender address (lowercased), display name (empty when it is just the address), subject, Message-ID and the new text.
 */
export function parseEmail(raw) {
  const msg = splitMessage(String(raw));
  const fromHeader = decodeWords(msg.headers.from || '');
  const addr = (/<([^>]+)>/.exec(fromHeader)?.[1] || fromHeader).trim().toLowerCase();
  const name = fromHeader.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  const t = findText(msg);
  return {
    from: addr, name: name && name.toLowerCase() !== addr ? name : '',
    subject: decodeWords(msg.headers.subject || '').trim(),
    messageId: (msg.headers['message-id'] || '').trim(),
    text: trimQuoted(t ? t.text : ''),
  };
}
