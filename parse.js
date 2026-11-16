// FastMark — a from-scratch Markdown renderer whose parse() returns exactly
// the HTML marked 18.1.3 renders with its default options (GFM on, breaks
// off). Written fresh in this session.
//
// Design: a line-based block parser (headings, fences, lists, quotes,
// tables, HTML blocks, reference definitions) hands plain-text runs to a
// single-pass inline renderer that follows marked's own inline algorithm:
// links are consumed before code spans, and emphasis is resolved with
// marked's left/right-flanking delimiter runs over a masked source (code
// spans, link labels and HTML tags hidden), including its rule-of-three
// handling. The inline renderer produces HTML directly, without building
// an intermediate token array, and also tracks the plain-text form of a
// run so image alt text comes from the same parse.
//
// Dependency-free, deterministic, Node only.

const isDigit = (c) => c >= 48 && c <= 57;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAsciiPunct = (c) =>
  (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const isSpaceByte = (c) => c === 32 || (c >= 9 && c <= 13);
// JS \s (what marked's tag regex uses for whitespace): ASCII whitespace
// plus NBSP and the other Unicode spaces.
const isWs = (c) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F ||
  c === 0x205F || c === 0x3000 || c === 0xFEFF;

const _punctRe = /[\p{P}\p{S}]/u;
const _alnumRe = /[\p{L}\p{N}]/u;
const _spaceRe = /\s/;
const _kindCache = new Map();
// Classify a code point: 0 other, 1 punctuation/symbol, 2 letter/number,
// 3 whitespace. Results are cached; the cache is bounded.
function charKind(ch) {
  const code = ch.codePointAt(0);
  let k = _kindCache.get(code);
  if (k === undefined) {
    if (_spaceRe.test(ch)) k = 3;
    else if (_punctRe.test(ch)) k = 1;
    else if (_alnumRe.test(ch)) k = 2;
    else k = 0;
    if (_kindCache.size < 4096) _kindCache.set(code, k);
  }
  return k;
}
function asciiKind(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return 3;
  if (isAsciiPunct(c)) return 1;
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 2;
  return 0;
}
// Kind of the code point starting at s[i]; out of range counts as whitespace.
function kindAt(s, i) {
  if (i < 0 || i >= s.length) return 3;
  const c = s.charCodeAt(i);
  if (c < 128) return asciiKind(c);
  return charKind(String.fromCodePoint(s.codePointAt(i)));
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (ch) => ESC_MAP[ch] || ch;
const ESC_NEED_RE = /[&<>"']/;

// Escape text the way marked does with encode=false: & < > " ' are escaped,
// except an & that starts a named reference (&word;) or a valid numeric
// reference — numeric references are decoded to the character (0, surrogates
// and > U+10FFFF become U+FFFD; 38 becomes &amp;).
function escText(s) {
  if (!ESC_NEED_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (s.charCodeAt(i + 1) === 35) {
        let j = i + 2;
        let hex = false;
        if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
        let k = j;
        while (k < s.length && (hex ? isHexCh(s.charCodeAt(k)) : isDigit(s.charCodeAt(k)))) k++;
        if (k > j && s.charCodeAt(k) === 59 && (hex ? k - j <= 6 : k - j <= 7)) {
          const num = parseInt(s.slice(j, k), hex ? 16 : 10);
          let rep;
          if (num === 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) rep = '\uFFFD';
          else if (num === 38) rep = '&amp;';
          else rep = String.fromCodePoint(num);
          out += s.slice(start, i) + (rep.length === 1 ? escChar(rep) : rep);
          i = k;
          start = i + 1;
          continue;
        }
      } else {
        let k = i + 1;
        while (k < s.length && isWordCh(s.charCodeAt(k))) k++;
        if (k > i + 1 && s.charCodeAt(k) === 59) { i = k; continue; }
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}
const isHexCh = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isWordCh = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

// Escape with encode=true: every & becomes &amp; (code spans, code blocks).
function escEncode(s) {
  if (!ESC_NEED_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references in a label or URL (marked's unescape):
// a bare & that does not start a valid numeric reference becomes &amp;.
function decodeNums(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 38) continue;
    if (s.charCodeAt(i + 1) === 35) {
      let j = i + 2;
      let hex = false;
      if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
      let k = j;
      while (k < s.length && (hex ? isHexCh(s.charCodeAt(k)) : isDigit(s.charCodeAt(k)))) k++;
      if (k > j && s.charCodeAt(k) === 59 && (hex ? k - j <= 6 : k - j <= 7)) {
        const num = parseInt(s.slice(j, k), hex ? 16 : 10);
        let rep;
        if (num === 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) rep = '\uFFFD';
        else if (num === 38) rep = '&amp;';
        else rep = String.fromCodePoint(num);
        out += s.slice(start, i) + rep;
        i = k;
        start = i + 1;
        continue;
      }
    }
    out += s.slice(start, i) + '&amp;';
    start = i + 1;
  }
  return out + s.slice(start);
}

// marked's cleanUrl: encodeURI (with %25 restored); null only when
// encodeURI throws (a lone surrogate). No scheme is blocked.
function cleanUrl(href) {
  if (href === null || href === undefined) return null;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalise a link label the way marked does: collapse whitespace, trim,
// then the case-fold chain that folds U+1E9E (capital sharp s) to "ss".
function labelNorm(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------- scanners
// Scan an inline HTML construct starting at s[i] === '<'; return the index
// just past it, or -1. Covers comments, processing instructions,
// declarations, CDATA sections, and open/close tags with attributes.
function scanTag(s, i) {
  const n = s.length;
  if (s[i + 1] === '!') {
    if (s.startsWith('<!--', i)) {
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e < 0 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e < 0 ? -1 : e + 3;
    }
    if (i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && isAlpha(s.charCodeAt(j))) j++;
      if (j < n && isWs(s.charCodeAt(j))) {
        const e = s.indexOf('>', j);
        return e < 0 ? -1 : e + 1;
      }
    }
    return -1;
  }
  if (s[i + 1] === '?') {
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  let j = i + 1;
  let close = false;
  if (s[j] === '/') { close = true; j++; }
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  j++;
  while (j < n && (isAlpha(s.charCodeAt(j)) || isDigit(s.charCodeAt(j)) || s[j] === '-')) j++;
  if (close) {
    while (j < n && isWs(s.charCodeAt(j))) j++;
    return j < n && s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    let k = j;
    while (k < n && isWs(s.charCodeAt(k))) k++;
    if (k >= n) return -1;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/' && s[k + 1] === '>') return k + 2;
    if (k === j) return -1;
    j = k;
    const c0 = s.charCodeAt(j);
    if (!(isAlpha(c0) || s[j] === '_' || s[j] === ':')) return -1;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isAlpha(c) || isDigit(c) || s[j] === '_' || s[j] === '.' || s[j] === ':' || s[j] === '-') j++;
      else break;
    }
    let k2 = j;
    while (k2 < n && isWs(s.charCodeAt(k2))) k2++;
    if (s[k2] === '=') {
      j = k2 + 1;
      while (j < n && isWs(s.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return -1;
        j = e + 1;
      } else {
        const v0 = j;
        while (j < n) {
          const c = s.charCodeAt(j);
          if (isWs(c) || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          j++;
        }
        if (j === v0) return -1;
      }
    }
  }
}

// Parse a link destination starting at pos. Returns {dest, end} (end just
// past the destination) or null. Angle destinations decode backslash
// escapes; bare destinations count balanced parentheses.
function parseDest(s, pos) {
  const n = s.length;
  if (s[pos] === '<') {
    let out = '';
    let i = pos + 1;
    while (i < n) {
      const c = s[i];
      if (c === '>') return { dest: out, end: i + 1 };
      if (c === '<' || c === '\n') return null;
      if (c === '\\' && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
      out += c;
      i++;
    }
    return null;
  }
  let out = '';
  let depth = 0;
  let i = pos;
  while (i < n) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (code <= 32) break;
    if (c === '\\' && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    out += c;
    i++;
  }
  if (i === pos) return null;
  return { dest: out, end: i };
}

// Parse a link title starting at pos (the opening quote or paren).
// Returns {title, end} or null.
function parseTitle(s, pos) {
  const n = s.length;
  const q = s[pos];
  if (q === '"' || q === "'") {
    let out = '';
    let i = pos + 1;
    while (i < n) {
      const c = s[i];
      if (c === q) return { title: out, end: i + 1 };
      if (c === '\\' && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
      out += c;
      i++;
    }
    return null;
  }
  if (q === '(') {
    let out = '';
    let depth = 1;
    let i = pos + 1;
    while (i < n) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return { title: out, end: i + 1 };
      }
      if (c === '\\' && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
      out += c;
      i++;
    }
    return null;
  }
  return null;
}

// Skip spaces/tabs, and — when multi is true — any number of newlines (with
// their following spaces); otherwise at most one newline. Returns the new
// index, or -1 if a blank line was crossed when multi is false.
function skipWs(s, pos, multi) {
  const n = s.length;
  let i = pos;
  for (;;) {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (s[i] === '\n') {
      if (!multi) {
        let j = i + 1;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        if (s[j] === '\n' || j >= n) return -1;
        return j;
      }
      i++;
      continue;
    }
    return i;
  }
}

// ---------------------------------------------------------------- inline rules
// The inline patterns, taken from marked's GFM rule set. Each is a
// module-level constant so it is compiled once at load.
const ESC_RE = new RegExp("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])", "");
const TAG_RE = new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", "");
const LINK_RE = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", "");
const REFLINK_RE = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", "");
const NOLINK_RE = new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", "");
const REFLINK_SEARCH_RE = new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g");
const CODE_RE = new RegExp("^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)", "");
const BR_RE = new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", "");
const DEL_LDELIM_RE = new RegExp("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u");
const DEL_RDELIM_RE = new RegExp("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu");
const EM_LDELIM_RE = new RegExp("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u");
const EM_RDELIM_AST_RE = new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu");
const EM_RDELIM_UND_RE = new RegExp("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu");
const AUTOLINK_RE = new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>", "");
const URL_RE = new RegExp("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])", "");
const BACKPEDAL_RE = new RegExp("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+", "");
const TEXT_RE = new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))", "");
const PUNCT_RE = new RegExp("^((?![*_])[\\s\\p{P}\\p{S}])", "u");
const ANY_PUNCT_RE = new RegExp("\\\\([\\p{P}\\p{S}])", "gu");
const ANY_PUNCT_OUTSIDE_CODE_RE = new RegExp("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", "gu");
const BLOCK_SKIP_RE = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");
const UNICODE_ALNUM_RE = new RegExp("[\\p{L}\\p{N}]", "u");
const OUTPUT_LINK_REPLACE_RE = /\\([\[\]])/g;
const START_ANGLE_RE = /^</;
const END_ANGLE_RE = />$/;
const START_A_TAG_RE = /^<a /i;
const END_A_TAG_RE = /^<\/a>/i;
const START_PRE_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const HAS_EM_RE = /[*_~]/;


// ---------------------------------------------------------------- masking
// Does the text s contain a link (inline or reference) that is not an
// image? Used while masking reference-link labels.
function linkInText(s, refs) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(REFLINK_SEARCH_RE)) {
    const r = m[0];
    const o = r.lastIndexOf('[');
    if (!(r.charAt(0) === '!' || !refs.has(labelNorm(r.slice(o + 1, -1)))) &&
        !(o > 1 && linkInText(r.slice(1, o - 1), refs))) return true;
  }
  return false;
}

// The masked form of src used for emphasis matching: reference-link
// labels that resolve, code spans and HTML tags are hidden at the same
// length (a run of 'a's inside brackets), so a delimiter inside one can
// never pair with a delimiter outside it. Escaped punctuation is hidden
// as '+' and backticks inside code spans likewise.
function maskSrc(src, refs) {
  let t = src;
  if (refs && src.includes('[')) {
    const sub = (r) => {
      const o = r.lastIndexOf('[');
      if (!refs.has(labelNorm(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, refs)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, sub) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, sub);
  }
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, s, r) =>
      r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  }
  return t;
}

// Index of the last delimiter run that could close emphasis (per char),
// and the last ~ run that could close a deletion, in the masked source.
// A run only counts when the character before it is not whitespace.
function lastClosers(a) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    for (; i < n && a[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Strip trailing characters: with t falsy, strip chars equal to e; with t
// truthy, strip chars NOT equal to e.
function stripTrail(a, e, t) {
  const n = a.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const r = a.charAt(n - s - 1);
    if (r === e && !t) s++;
    else if (r !== e && t) s++;
    else break;
  }
  return a.slice(0, n - s);
}

// Index of the unmatched close paren in a (nested opens counted, backslash
// escapes skipped): -1 when there is none, -2 when an open is unbalanced.
function parenBalance(a, e) {
  if (a.indexOf(e[0]) === -1 && a.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === e[0]) t++;
    else if (a[n] === e[1]) { t--; if (t < 0) return n; }
  }
  return t > 0 ? -2 : -1;
}

// Does the link label e contain a '<' that starts a tag or autolink whose
// raw form runs past the end of the label? a is the remaining source and t
// is the label's offset inside the raw link match (1, or 2 for images).
function labelHasTag(a, e, t) {
  if (!e.includes('<')) return false;
  for (let s = 0; s < e.length; s++) {
    if (e[s] === '\\') { s++; continue; }
    if (e[s] === '`') {
      const i = CODE_RE.exec(e.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (e[s] !== '<') continue;
    const r = a.slice(t + s);
    const o = TAG_RE.exec(r) || AUTOLINK_RE.exec(r);
    if (o) {
      if (o[0].length > e.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

const cpCount = (s) => [...s].length;
// UTF-16 length of the first code point of s (1, or 2 for an astral char).
const cpLen = (s) => (s.codePointAt(0) > 0xffff ? 2 : 1);
// Length in code points of a run of the ASCII delimiter char r at the
// head of s (delimiter runs are ASCII, so this is exact without spreading).
const runLen = (s, r) => {
  let k = 0;
  while (k < s.length && s[k] === r) k++;
  return k;
};

// ---------------------------------------------------------------- emphasis
// Match an emphasis/strong run starting at the head of rem. maskedFull is
// the masked form of the whole inline string of this call, off is the
// absolute index of rem inside it, prevCh the character before the run
// ("" when the previous token was not text), closers the last-closer
// indexes for maskedFull. Returns {raw, inner, strong} or null.
function emStrong(rem, maskedFull, off, prevCh, closers) {
  const s = EM_LDELIM_RE.exec(rem);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevCh === r;
  const i = off;
  let l = i;
  while (l > 0 && maskedFull[l - 1] === r) l--;
  const p = l > 0 ? [...maskedFull.slice(Math.max(0, l - 2), l)].at(-1) : '';
  const h = p === '*' || p === '_' || !!PUNCT_RE.exec(p);
  let n = prevCh;
  if (l < i) n = p;
  const u = l < i ? h : !!PUNCT_RE.exec(n);
  if (s[4] && n.match(UNICODE_ALNUM_RE)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = runLen(s[0], r);
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
    const v = closers.em[r];
    const Q = off + k;
    if (v < Q) return null;
    const t = maskedFull.slice(Q);
    const ee = v - Q;
    A.lastIndex = 0;
    for (;;) {
      const m2 = A.exec(t);
      if (m2 === null || m2.index > ee) break;
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      let b = g.length;
      if (m2[3] || m2[4]) { m += b; continue; }
      if (m2[5] || m2[6] || R) {
        if (o && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = cpLen(m2[0]);
      const M = rem.slice(0, k + m2.index + te + b);
      if (Math.min(k, b) % 2) {
        return { raw: M, inner: M.slice(1, -1), strong: false };
      }
      return { raw: M, inner: M.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Match a ~~deletion~~ starting at the head of rem. Same arguments as
// emStrong. Returns {raw, inner} or null.
function delTok(rem, maskedFull, off, prevCh, closers) {
  const s = DEL_LDELIM_RE.exec(rem);
  if (!s) return null;
  if (!(s[1] || '') || !prevCh || PUNCT_RE.exec(prevCh)) {
    const o = runLen(s[0], '~');
    let p = o;
    const u = closers.del;
    const d = off + o;
    if (u < d) return null;
    const t = maskedFull.slice(d);
    const k = u - d;
    DEL_RDELIM_RE.lastIndex = 0;
    for (;;) {
      const m = DEL_RDELIM_RE.exec(t);
      if (m === null || m.index > k) break;
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      let l = g.length;
      if (l !== o) continue;
      if (m[3] || m[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = cpLen(m[0]);
      const raw = rem.slice(0, o + m.index + te + l);
      return { raw, inner: raw.slice(o, -o) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- inline
const CODE_NL_RE = /\n/g;
const CODE_NONSPACE_RE = /[^ ]/;

// Document-level inline state, shared across the blocks of one document
// (marked's lexer state): inLink is set while a link label is parsed and
// by raw <a> tags; inRawBlock while inside <pre>/<code>/<kbd>/<script>;
// linkEmitted records whether a link was produced while parsing a label;
// linkParenPossible gates inline links.
function newInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
}

// Build the link/image result for a matched link. m is the regex match
// (m[1] = label), ref = {href, title}, raw = the full matched text.
// Returns {html, text, raw} for the whole construct, or null when the
// construct must be dropped (a link whose label itself produced a link).
function makeLink(m, ref, raw, st, refs, needText) {
  const href = ref.href;
  const title = ref.title || null;
  const label = m[1].replace(OUTPUT_LINK_REPLACE_RE, '$1');
  const isImg = m[0].charAt(0) === '!';
  const prevInLink = st.inLink;
  const prevEmitted = st.linkEmitted;
  const prevRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const lab = inline(label, refs, st, needText || isImg, false);
  const nested = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!isImg) {
    if (nested) { st.inRawBlock = prevRaw; return null; }
    st.linkEmitted = true;
  }
  const url = cleanUrl(href);
  if (isImg) {
    if (url === null) return { html: escText(lab.t), text: lab.t, raw };
    let html = '<img src="' + escText(url) + '" alt="' + escText(lab.t) + '"';
    if (title != null) html += ' title="' + escText(title) + '"';
    html += '>';
    return { html, text: lab.t, raw };
  }
  if (url === null) return { html: lab.h, text: lab.t, raw };
  let html = '<a href="' + escText(url) + '"';
  if (title != null) html += ' title="' + escText(title) + '"';
  html += '>' + lab.h + '</a>';
  return { html, text: lab.t, raw };
}

// Try an inline link or image at the head of rem. Returns the makeLink
// result or null.
function tryLink(rem, st, refs, needText) {
  if (st.linkParenPossible === false) return null;
  const m = LINK_RE.exec(rem);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(rem, m[1], off)) return null;
  const dest = m[2].trim();
  if (START_ANGLE_RE.test(dest)) {
    if (!END_ANGLE_RE.test(dest)) return null;
    const l = stripTrail(dest.slice(0, -1), '\\');
    if ((dest.length - l.length) % 2 === 0) return null;
  } else {
    const l = parenBalance(m[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = stripTrail(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (START_ANGLE_RE.test(href)) href = href.slice(1, -1);
  return makeLink(m, {
    href: href && href.replace(ANY_PUNCT_RE, '$1'),
    title: title && title.replace(ANY_PUNCT_RE, '$1'),
  }, m[0], st, refs, needText);
}

// Try a reference link/image at the head of rem. When the reference does
// not exist, the '[' (or '!') is plain text: a one-character result with
// single set, so the caller does not treat it as a completed text run.
function tryReflink(rem, st, refs, needText) {
  const m = REFLINK_RE.exec(rem) || NOLINK_RE.exec(rem);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(rem, m[1], off)) return null;
  const ref = refs.get(labelNorm(m[2] || m[1]));
  if (!ref) {
    const ch = m[0].charAt(0);
    return { html: escText(ch), text: ch, raw: ch, single: true };
  }
  return makeLink(m, ref, m[0], st, refs, needText);
}

// Render one inline run. Returns {h, t}: the HTML and (when needText) the
// plain-text form of the run. st is the document inline state; top marks a
// top-level call (one block's inline content), which resets inRawBlock.
function inline(src, refs, st, needText, top) {
  if (!src) return { h: '', t: '' };
  if (top) st.inRawBlock = false;
  const saveParen = st.linkParenPossible;
  st.linkParenPossible = saveParen && src.includes(')');
  const maskedFull = HAS_EM_RE.test(src) ? maskSrc(src, refs) : src;
  let h = '';
  let t = '';
  let rem = src;
  let closers = null;
  let prevCh = '';
  let prevWasText = false;
  try {
    while (rem) {
      if (!prevWasText) prevCh = '';
      prevWasText = false;
      const off = maskedFull.length - rem.length;
      const c0 = rem.charCodeAt(0);
      let m;
      // Dispatch on the first character: only the tokenizers that can
      // start there are tried, in marked's order. Every other position
      // falls through to the bare-URL check and then plain text.
      if (c0 === 92) {
        if ((m = ESC_RE.exec(rem))) {
          const ch = m[1];
          h += escText(ch);
          if (needText) t += ch;
          rem = rem.substring(m[0].length);
          continue;
        }
        if ((m = BR_RE.exec(rem))) {
          h += '<br>';
          rem = rem.substring(m[0].length);
          continue;
        }
      } else if (c0 === 60) {
        if ((m = TAG_RE.exec(rem))) {
          const raw = m[0];
          if (!st.inLink && START_A_TAG_RE.test(raw)) st.inLink = true;
          else if (st.inLink && END_A_TAG_RE.test(raw)) st.inLink = false;
          if (!st.inRawBlock && START_PRE_RE.test(raw)) st.inRawBlock = true;
          else if (st.inRawBlock && END_PRE_RE.test(raw)) st.inRawBlock = false;
          h += raw;
          if (needText) t += raw;
          rem = rem.substring(raw.length);
          continue;
        }
        if ((m = AUTOLINK_RE.exec(rem))) {
          const inner = m[1];
          const href = m[2] === '@' ? 'mailto:' + inner : inner;
          const url = cleanUrl(href);
          if (url === null) {
            h += escEncode(inner);
            if (needText) t += inner;
          } else {
            h += '<a href="' + escEncode(url) + '">' + escEncode(inner) + '</a>';
            if (needText) t += inner;
          }
          rem = rem.substring(m[0].length);
          continue;
        }
      } else if (c0 === 91 || c0 === 33) {
        const link = tryLink(rem, st, refs, needText);
        if (link) {
          h += link.html;
          if (needText) t += link.text;
          rem = rem.substring(link.raw.length);
          continue;
        }
        const ref = tryReflink(rem, st, refs, needText);
        if (ref) {
          h += ref.html;
          if (needText) t += ref.text;
          rem = rem.substring(ref.raw.length);
          continue;
        }
      } else if (c0 === 42 || c0 === 95) {
        if (!closers) closers = lastClosers(maskedFull);
        const em = emStrong(rem, maskedFull, off, prevCh, closers);
        if (em) {
          const inner = inline(em.inner, refs, st, needText, false);
          h += em.strong ? '<strong>' + inner.h + '</strong>' : '<em>' + inner.h + '</em>';
          if (needText) t += inner.t;
          rem = rem.substring(em.raw.length);
          continue;
        }
      } else if (c0 === 96) {
        if ((m = CODE_RE.exec(rem))) {
          let code = m[2].replace(CODE_NL_RE, ' ');
          if (CODE_NONSPACE_RE.test(code) && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ') {
            code = code.substring(1, code.length - 1);
          }
          h += '<code>' + escEncode(code) + '</code>';
          if (needText) t += code;
          rem = rem.substring(m[0].length);
          continue;
        }
      } else if (c0 === 126) {
        if (!closers) closers = lastClosers(maskedFull);
        const del = delTok(rem, maskedFull, off, prevCh, closers);
        if (del) {
          const inner = inline(del.inner, refs, st, needText, false);
          h += '<del>' + inner.h + '</del>';
          if (needText) t += inner.t;
          rem = rem.substring(del.raw.length);
          continue;
        }
      } else if (c0 === 32) {
        if ((m = BR_RE.exec(rem))) {
          h += '<br>';
          rem = rem.substring(m[0].length);
          continue;
        }
      } else if (!st.inLink && (m = URL_RE.exec(rem))) {
        let text;
        let href;
        if (m[2] === '@') {
          text = m[0];
          href = 'mailto:' + m[0];
        } else {
          let raw = m[0];
          let prev;
          do {
            prev = raw;
            raw = BACKPEDAL_RE.exec(raw)?.[0] ?? '';
          } while (raw !== prev);
          text = raw;
          href = m[1] === 'www.' ? 'http://' + raw : raw;
        }
        const url = cleanUrl(href);
        if (url === null) {
          h += escEncode(text);
          if (needText) t += text;
        } else {
          h += '<a href="' + escEncode(url) + '">' + escEncode(text) + '</a>';
          if (needText) t += text;
        }
        rem = rem.substring(text.length);
        continue;
      }
      m = TEXT_RE.exec(rem);
      if (!m) {
        const ch = rem.charAt(0);
        h += escText(ch);
        if (needText) t += decodeNums(ch);
        prevCh = ch;
        prevWasText = true;
        rem = rem.substring(1);
        continue;
      }
      const raw = m[0];
      if (st.inRawBlock) {
        h += raw;
        if (needText) t += raw;
      } else {
        h += escText(raw);
        if (needText) t += decodeNums(raw);
      }
      if (raw.charAt(raw.length - 1) !== '_') prevCh = raw.charAt(raw.length - 1);
      prevWasText = true;
      rem = rem.substring(raw.length);
    }
  } finally {
    st.linkParenPossible = saveParen;
  }
  return { h, t };
}

// ---------------------------------------------------------------- blocks
// Column width of the leading whitespace of a line (tab = next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Remove the first n columns of indentation; a tab straddling the boundary
// turns into the spaces that remain.
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// marked's indentCodeCompensation for a BACKTICK fence: slice
// min(leading-whitespace chars, fence-indent chars) off the front. A tab
// counts as ONE character here, not four columns. A tilde fence has no
// compensation at all, so its content keeps its indent.
function stripFenceIndent(line, n) {
  if (n <= 0) return line;
  let m = 0;
  while (m < line.length && (line[m] === ' ' || line[m] === '\t')) m++;
  if (m === 0) return line;
  return line.slice(Math.min(m, n));
}

const BLOCK_TAGS = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|\/?$)/;

// HTML block start: returns the type (1..7) or 0. inPara disables type 7.
// maxIndent caps the allowed leading-space indent (default 3).
function htmlBlockType(line, inPara, maxIndent) {
  const maxI = maxIndent === undefined ? 3 : maxIndent;
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > maxI) return 0;
  if (line[i] !== '<') return 0;
  const rest = line.slice(i);
  const low = rest.toLowerCase();
  if (/^<(script|pre|style|textarea)(\s|>|$)/.test(low)) return 1;
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (/^<![a-z]/.test(low)) return 4;
  if (low.startsWith('<![cdata[')) return 5;
  if (BLOCK_TAGS.test(low)) return 6;
  if (!inPara) {
    const te = scanTag(rest, 0);
    if (te > 0 && /^[ \t]*$/.test(rest.slice(te))) return 7;
  }
  return 0;
}

function isThematicBreak(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return false;
  const ch = line[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ' ' || c === '\t') continue;
    if (c === ch) { count++; continue; }
    return false;
  }
  return count >= 3;
}

// A setext underline: a run of one kind of character (= or -), indented at
// most 3 spaces, followed only by trailing whitespace. Returns 1 for =,
// 2 for -, 0 otherwise.
function isSetext(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return 0;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? (ch === '=' ? 1 : 2) : 0;
}

function atxMatch(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  let j = i;
  while (j < line.length && line[j] === '#') j++;
  const level = j - i;
  if (level === 0 || level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  let text = line.slice(j).trim();
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[\s]+#+[\s]*$/, '').trim();
  return { level, text };
}

function fenceMatch(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = line.slice(j).trim();
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len, info, indent: i };
}

// Split a table row line into cells (unescaped pipes split; leading and
// trailing pipes are dropped).
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const start = i;
  let first = true;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') {
      if (first && cur.trim() === '' && i === start) { first = false; continue; }
      cells.push(cur);
      cur = '';
      first = false;
      continue;
    }
    cur += c;
    first = false;
  }
  cells.push(cur);
  let t = line.length - 1;
  while (t >= 0 && (line[t] === ' ' || line[t] === '\t')) t--;
  if (line[t] === '|' && cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function isTableDelimiter(line) {
  if (indentCols(line) > 3) return null;
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] === ':' && m[2] === ':' ? 'center' : m[2] === ':' ? 'right' : m[1] === ':' ? 'left' : null);
  }
  return aligns;
}

// List marker at the start of a line (indent <= 3). Returns null or
// {bullet, ordered, delim, start, indent, contentIndent, contentStart,
// wsWidth, blankItem}.
function listMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const indent = i;
  const ch = line[i];
  if (ch === '-' || ch === '+' || ch === '*') {
    const after = line[i + 1];
    if (after !== undefined && after !== ' ' && after !== '\t') return null;
    return finishMarker(line, indent, false, ch, null, i + 1);
  }
  if (isDigit(line.charCodeAt(i))) {
    let j = i;
    while (j < line.length && isDigit(line.charCodeAt(j))) j++;
    if (j - i > 9) return null;
    const delim = line[j];
    if (delim !== '.' && delim !== ')') return null;
    const after = line[j + 1];
    if (after !== undefined && after !== ' ' && after !== '\t') return null;
    const start = parseInt(line.slice(i, j), 10);
    return finishMarker(line, indent, true, delim, start, j + 1);
  }
  return null;
}

function finishMarker(line, indent, ordered, delim, start, afterMarker) {
  let j = afterMarker;
  let spaces = 0;
  let col = indent + (afterMarker - indent);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { spaces++; col++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; }
    j++;
  }
  const rest = line.slice(j);
  let contentIndent;
  let contentStart;
  if (rest === '' || spaces >= 5) {
    contentIndent = indent + (afterMarker - indent) + 1;
    contentStart = j;
  } else {
    contentIndent = col;
    contentStart = j;
  }
  return { ordered, delim, start, indent, contentIndent, contentStart, wsWidth: spaces, blankItem: rest === '' };
}

// The first line of a list item, with the marker and its following
// whitespace removed. The whitespace run after the marker is expanded by
// column; if it is wider than 4 columns, only one column is consumed and
// the rest stays as leading spaces of the content.
function stripItemFirstLine(line, m) {
  if (m.blankItem) return '';
  if (m.wsWidth >= 5) return ' '.repeat(m.wsWidth - 1) + line.slice(m.contentStart);
  return line.slice(m.contentStart);
}

// Expand the leading run of spaces/tabs of a line to spaces (a tab goes to
// the next multiple of 4, from column 0). Only the leading run is expanded.
function expandLeading(line) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(i);
}
function expandTabsAll(s) {
  return s.indexOf('\t') < 0 ? s : s.replace(/\t/g, '    ');
}

// Remove a blockquote marker: the '>' at column q plus one following space,
// expanding tabs in the whitespace run by column.
function stripQuoteLine(line, q) {
  let col = q + 1;
  let j = q + 1;
  let spaces = 0;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { spaces++; col++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; }
    j++;
  }
  if (spaces === 0) return line.slice(q + 1);
  return ' '.repeat(spaces - 1) + line.slice(j);
}

// A list marker that can interrupt a paragraph: any bullet, or an ordered
// marker. At the top level an ordered marker must start at 1 to interrupt;
// inside a list item (top=false) any start number interrupts.
function listMarkerInterrupts(l, top) {
  const m = listMarker(l);
  return !!m && !m.blankItem && (!m.ordered || top === false || m.start === 1);
}

// Does this line start a block (fence, ATX heading, HTML block, blockquote,
// list marker, thematic break) with an indent of at most `a` columns?
function lineBreaksItem(line, a) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k > a) return false;
  const rest = line.slice(k);
  if (/^(?:`{3,}|~{3,})/.test(rest)) return true;
  if (/^#{1,6}(?:\s|$)/.test(rest)) return true;
  if (rest[0] === '>') return true;
  if (htmlBlockType(line, true, a) !== 0) return true;
  if (/^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) || /^(?:\*[ \t]*){3,}$/.test(rest)) return true;
  const m = listMarker(line);
  if (m && m.indent <= a) return true;
  return false;
}

// ---------------------------------------------------------------- references
// Try to read one or more link reference definitions starting at lines[i].
// Returns the index of the first line after the definitions, or i if none.
function parseRefDefs(lines, i, hi, refs) {
  let cur = i;
  while (cur < hi) {
    const end = parseOneRefDef(lines, cur, hi, refs);
    if (end <= cur) break;
    cur = end;
  }
  return cur;
}

function parseOneRefDef(lines, i, hi, refs) {
  let take = 0;
  while (take < 12 && i + take < hi && !isBlank(lines[i + take])) take++;
  const joined = lines.slice(i, i + take).join('\n');
  let p = 0;
  let sp = 0;
  while (p < joined.length && joined[p] === ' ') { p++; sp++; }
  if (sp > 3 || joined[p] !== '[') return i;
  let depth = 1;
  let q = p + 1;
  let label = '';
  while (q < joined.length) {
    const ch = joined[q];
    if (ch === '\\' && q + 1 < joined.length) { label += joined[q] + joined[q + 1]; q += 2; continue; }
    if (ch === '[') return i;
    else if (ch === ']') { depth--; if (depth === 0) break; }
    label += ch;
    q++;
  }
  if (depth !== 0 || q >= joined.length) return i;
  if (label.trim() === '' || label.length > 999) return i;
  q++;
  if (joined[q] !== ':') return i;
  q++;
  const r = skipWs(joined, q, false);
  if (r < 0) return i;
  const d = parseDest(joined, r);
  if (!d) return i;
  const end = d.end;
  let lineEnd = end;
  while (lineEnd < joined.length && joined[lineEnd] !== '\n') lineEnd++;
  let title = null;
  let titleEnd = -1;
  let w = end;
  let spBefore = 0;
  while (w < joined.length && (joined[w] === ' ' || joined[w] === '\t')) { w++; spBefore++; }
  if (spBefore > 0 && w < lineEnd && (joined[w] === '"' || joined[w] === "'" || joined[w] === '(')) {
    const t = parseTitle(joined, w);
    if (t) {
      let after = t.end;
      while (after < lineEnd && (joined[after] === ' ' || joined[after] === '\t')) after++;
      if (after >= joined.length || joined[after] === '\n') { title = t.title; titleEnd = t.end; }
    }
  }
  if (title === null && lineEnd < joined.length) {
    let x = lineEnd + 1;
    while (x < joined.length && (joined[x] === ' ' || joined[x] === '\t')) x++;
    if (x < joined.length && (joined[x] === '"' || joined[x] === "'" || joined[x] === '(')) {
      const t = parseTitle(joined, x);
      if (t) {
        let after = t.end;
        while (after < joined.length && (joined[after] === ' ' || joined[after] === '\t')) after++;
        if (after >= joined.length || joined[after] === '\n') { title = t.title; titleEnd = t.end; }
      }
    }
  }
  let finalEnd;
  if (title !== null) {
    finalEnd = titleEnd;
  } else {
    let after = end;
    while (after < lineEnd && (joined[after] === ' ' || joined[after] === '\t')) after++;
    if (after !== lineEnd) return i;
    finalEnd = end;
  }
  const consumedLines = joined.slice(0, finalEnd).split('\n').length;
  const key = labelNorm(label);
  if (!refs.has(key)) refs.set(key, { href: d.dest, title });
  return i + consumedLines;
}

// ---------------------------------------------------------------- lists
// Parse a list starting at lines[i]. Returns {node, next}.
function parseList(lines, i, hi, refs, eofNL) {
  const first = listMarker(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const items = [];
  let loose = false;
  let idx = i;
  while (idx < hi) {
    if (isThematicBreak(lines[idx])) break;
    const m = listMarker(lines[idx]);
    if (!m || m.indent > 3 || m.ordered !== ordered || m.delim !== delim) break;
    const ci = m.contentIndent;
    const a = Math.max(0, Math.min(3, ci - 1));
    const itemLines = [stripItemFirstLine(lines[idx], m)];
    idx++;
    let prevContent = itemLines[0];
    let prevIndented = false;
    let prevBlank = itemLines[0].trim() === '';
    let pendingBlanks = [];
    let siblingBreak = false;
    if (prevBlank && idx < hi && isBlank(lines[idx])) {
      pendingBlanks.push('');
      idx++;
      items.push([]);
      const nextM = idx < hi ? listMarker(lines[idx]) : null;
      if (nextM && nextM.indent <= 3 && nextM.ordered === ordered && nextM.delim === delim) loose = true;
      continue;
    }
    while (idx < hi) {
      const line = lines[idx];
      if (isBlank(line)) { pendingBlanks.push(''); prevBlank = true; prevContent = ''; prevIndented = false; idx++; continue; }
      const expanded = expandLeading(line);
      const firstNonSpace = expanded.search(/[^ ]/);
      if (firstNonSpace >= ci) {
        if (pendingBlanks.length) { itemLines.push(...pendingBlanks); pendingBlanks = []; }
        const content = expanded.slice(ci);
        itemLines.push(content);
        prevContent = content;
        prevIndented = true;
        prevBlank = false;
        idx++;
        continue;
      }
      const nm = listMarker(line);
      if (nm && nm.indent <= 3 && nm.ordered === ordered && nm.delim === delim && nm.indent < ci) {
        if (pendingBlanks.length) loose = true;
        pendingBlanks = [];
        siblingBreak = true;
        break;
      }
      if (lineBreaksItem(line, a)) break;
      if (prevBlank) break;
      const prevExpanded = expandTabsAll(prevContent);
      if (prevIndented && prevExpanded.search(/[^ ]/) >= 4 && prevExpanded.trim() !== '') break;
      if (fenceMatch(prevContent) || atxMatch(prevContent) || htmlBlockType(prevContent, true) !== 0 || isThematicBreak(prevContent)) break;
      if (pendingBlanks.length) { itemLines.push(...pendingBlanks); pendingBlanks = []; }
      let content = line;
      if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && prevContent.trim() !== '' && !lineBreaksItem(prevContent, a)) {
        content = '    ' + expanded.replace(/^ {0,3}/, '');
      }
      itemLines.push(content);
      prevContent = content;
      prevIndented = false;
      prevBlank = false;
      idx++;
    }
    if (!siblingBreak && pendingBlanks.length) idx -= pendingBlanks.length;
    while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    items.push(itemLines);
  }
  const node = { t: 'list', ordered, start: first.start, loose, items: [] };
  for (const itemLines of items) {
    const nodes = (itemLines.length === 0 || (itemLines.length === 1 && isBlank(itemLines[0])))
      ? []
      : parseBlocks(itemLines, 0, itemLines.length, refs, { eofNL: false, top: false });
    if (nodes.hasBlankBetweenBlocks) loose = true;
    node.items.push({ nodes });
  }
  node.loose = loose;
  return { node, next: idx };
}

// ---------------------------------------------------------------- block parser
// lines[lo..hi) are the lines to parse; refs is the shared link-reference
// map, filled as definitions are met. Returns an array of block nodes;
// inline parsing happens later, in renderBlocks, once every definition in
// the document is known (so a reference defined after its use resolves).
// opts.eofNL tells whether the last line is followed by a newline in the
// original source; opts.noSetext is a set of line indices that must not be
// read as setext underlines (lazy lines inside block quotes); top=false
// parses list-item or block-quote content, where an indented line is a
// code block rather than a paragraph continuation.
function parseBlocks(lines, lo, hi, refs, opts) {
  const eofNL = opts.eofNL === true;
  const noSetext = opts.noSetext || null;
  const top = opts.top !== false;
  const nodes = [];
  let sawBlank = false;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }
    if (sawBlank && nodes.length > 0) nodes.hasBlankBetweenBlocks = true;
    sawBlank = false;
    const afterDefs = parseRefDefs(lines, i, hi, refs);
    if (afterDefs > i) { i = afterDefs; continue; }
    const atx = atxMatch(line);
    if (atx) {
      nodes.push({ t: 'h', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    const fence = fenceMatch(line);
    if (fence) {
      const fIndent = fence.indent;
      const content = [];
      let j = i + 1;
      let closed = false;
      while (j < hi) {
        const l = lines[j];
        let k = 0;
        while (k < l.length && l[k] === ' ') k++;
        if (k <= 3 && l[k] === fence.ch) {
          let e = k;
          while (e < l.length && l[e] === fence.ch) e++;
          if (e - k >= fence.len && l.slice(e).trim() === '') { closed = true; break; }
        }
        content.push(fence.ch === '`' ? stripFenceIndent(l, fIndent) : l);
        j++;
      }
      if (content.length && j > i + 1 && lines[j - 1] === '') content.pop();
      const lang = fence.info.split(/\s+/)[0].replace(/\\([!-/:-@[-`{-~])/g, '$1') || '';
      nodes.push({ t: 'code', lang, text: content.length ? content.join('\n') + '\n' : '' });
      i = closed ? j + 1 : j;
      continue;
    }
    const htype = htmlBlockType(line, false);
    if (htype) {
      const start = i;
      i++;
      if (htype === 1) {
        const tagName = /^ {0,3}<(script|pre|style|textarea)/.exec(line.toLowerCase())[1];
        const endTag = '</' + tagName + '>';
        while (i < hi && lines[i - 1].toLowerCase().indexOf(endTag) < 0) i++;
      } else if (htype === 2) {
        while (i < hi && lines[i - 1].indexOf('-->') < 0) i++;
      } else if (htype === 3) {
        while (i < hi && lines[i - 1].indexOf('?>') < 0) i++;
      } else if (htype === 4) {
        while (i < hi && lines[i - 1].indexOf('>') < 0) i++;
      } else if (htype === 5) {
        while (i < hi && lines[i - 1].indexOf(']]>') < 0) i++;
      } else {
        while (i < hi && !isBlank(lines[i])) i++;
      }
      let text = lines.slice(start, i).join('\n');
      const nextLine = i < hi ? lines[i] : null;
      const keepNL = htype <= 5
        ? (nextLine !== null ? nextLine.length > 0 : eofNL)
        : (nextLine === null && eofNL);
      if (keepNL) text += '\n';
      nodes.push({ t: 'html', text });
      continue;
    }
    if (isThematicBreak(line)) { nodes.push({ t: 'hr' }); i++; continue; }
    {
      let k = 0;
      while (k < line.length && line[k] === ' ') k++;
      if (k <= 3 && line[k] === '>') {
        const qlines = [];
        const qNoSetext = new Set();
        let lastWasMarker = false;
        let inFence = null;
        let canLazy = false;
        const isPlainParaLine = (c) => {
          if (isBlank(c) || indentCols(c) >= 4) return false;
          if (atxMatch(c) || fenceMatch(c) || isThematicBreak(c) || htmlBlockType(c, true) !== 0) return false;
          if (isSetext(c) !== 0 || isTableDelimiter(c) || listMarker(c)) return false;
          let q = 0;
          while (q < c.length && c[q] === ' ') q++;
          if (q <= 3 && c[q] === '>') return false;
          if (/^ {0,3}\[[^\[\]]{1,999}\]:/.test(c)) return false;
          return true;
        };
        const noteLine = (c) => {
          if (inFence) {
            let kk = 0;
            while (kk < c.length && c[kk] === ' ') kk++;
            if (kk <= 3 && c[kk] === inFence.ch) {
              let e = kk;
              while (e < c.length && c[e] === inFence.ch) e++;
              if (e - kk >= inFence.len && c.slice(e).trim() === '') { inFence = null; canLazy = false; return; }
            }
            canLazy = false;
            return;
          }
          const fm = fenceMatch(c);
          if (fm) { inFence = { ch: fm.ch, len: fm.len }; canLazy = false; return; }
          if (isBlank(c) || indentCols(c) >= 4 || atxMatch(c) || isThematicBreak(c) ||
              htmlBlockType(c, true) !== 0 || isTableDelimiter(c)) {
            canLazy = false;
            return;
          }
          if (listMarker(c)) { canLazy = true; return; }
          if (isSetext(c) !== 0) { canLazy = false; return; }
          canLazy = true;
        };
        while (i < hi) {
          const l = lines[i];
          let q = 0;
          while (q < l.length && l[q] === ' ') q++;
          if (q <= 3 && l[q] === '>') {
            const c = stripQuoteLine(l, q);
            qlines.push(c);
            noteLine(c);
            lastWasMarker = true;
            i++;
            continue;
          }
          if (isBlank(l)) break;
          const lm = listMarker(l);
          if (canLazy && !atxMatch(l) && !fenceMatch(l) && htmlBlockType(l, true) === 0 &&
              !isThematicBreak(l) && !(lm && !lm.blankItem)) {
            const last = qlines[qlines.length - 1];
            if (!lastWasMarker && isSetext(l) !== 0) {
              qlines.push('    ' + expandLeading(l).replace(/^ {0,3}/, ''));
            } else if (lastWasMarker && indentCols(l) >= 4 && last !== undefined && isPlainParaLine(last)) {
              qlines[qlines.length - 1] += '\n' + stripCols(l, 4);
            } else {
              if (isSetext(l) !== 0) qNoSetext.add(qlines.length);
              qlines.push(l);
            }
            lastWasMarker = false;
            i++;
            continue;
          }
          break;
        }
        const kids = parseBlocks(qlines, 0, qlines.length, refs, { eofNL: false, noSetext: qNoSetext });
        nodes.push({ t: 'quote', kids });
        continue;
      }
    }
    if (listMarker(line)) {
      const r = parseList(lines, i, hi, refs, eofNL);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    if (indentCols(line) >= 4) {
      const codeStart = i;
      const content = [];
      while (i < hi) {
        const l = lines[i];
        if (isBlank(l)) {
          let q = i + 1;
          while (q < hi && isBlank(lines[q])) q++;
          if (q < hi && indentCols(lines[q]) >= 4) { content.push(stripCols(l, 4)); i++; continue; }
          break;
        }
        if (indentCols(l) < 4) break;
        content.push(stripCols(l, 4));
        i++;
      }
      const codeText = content.join('\n');
      const prev = nodes[nodes.length - 1];
      if (prev && prev.t === 'p' && prev.end === codeStart) {
        prev.text += '\n' + codeText;
        prev.end = i;
      } else {
        nodes.push({ t: 'code', lang: '', text: content.length ? codeText + '\n' : '' });
      }
      continue;
    }
    {
      const start = i;
      let j = i;
      let setextLevel = 0;
      let tableAligns = null;
      let tableHeader = null;
      while (j < hi) {
        const l = lines[j];
        if (j > start) {
          if (isBlank(l) && !(j === hi - 1 && !eofNL && l.length > 0)) break;
          if (!top && indentCols(l) >= 4) break;
          const sl = isSetext(l);
          if (sl && !(noSetext && noSetext.has(j))) { setextLevel = sl; break; }
          if (j === start + 1) {
            const al = isTableDelimiter(l);
            if (al && splitTableRow(lines[start]).length === al.length) {
              tableAligns = al;
              tableHeader = lines[start];
              break;
            }
          }
          if (atxMatch(l) || fenceMatch(l) || htmlBlockType(l, true) !== 0 || isThematicBreak(l)) break;
          let q = 0;
          while (q < l.length && l[q] === ' ') q++;
          if (q <= 3 && l[q] === '>') break;
          if (listMarkerInterrupts(l, top)) break;
        }
        j++;
      }
      if (setextLevel) {
        nodes.push({ t: 'h', level: setextLevel, text: lines.slice(start, j).join('\n').trim() });
        i = j + 1;
        continue;
      }
      if (tableAligns) {
        const headerCells = splitTableRow(tableHeader);
        const rows = [];
        let r = start + 2;
        while (r < hi && !/^ *$/.test(lines[r])) {
          const l = lines[r];
          if (indentCols(l) >= 4 && /[^ \t]/.test(l)) break;
          if (atxMatch(l) || fenceMatch(l) || htmlBlockType(l, true) !== 0 || isThematicBreak(l)) break;
          let q = 0;
          while (q < l.length && l[q] === ' ') q++;
          if (q <= 3 && l[q] === '>') break;
          if (listMarkerInterrupts(l)) break;
          rows.push(l);
          r++;
        }
        nodes.push({ t: 'table', header: headerCells, aligns: tableAligns, rows: rows.map((row) => splitTableRow(row)) });
        i = r;
        continue;
      }
      nodes.push({ t: 'p', text: lines.slice(start, j).join('\n'), end: j });
      i = j;
      continue;
    }
  }
  return nodes;
}

// ---------------------------------------------------------------- rendering
// Render block nodes to HTML. tight renders paragraphs at this level bare
// (no <p> tags, no trailing newline) — the tight-list rendering. st is the
// document-level inline state, shared across blocks.
function renderBlocks(nodes, refs, tight, st) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'p':
        out += tight ? inline(n.text, refs, st, false, true).h : '<p>' + inline(n.text, refs, st, false, true).h + '</p>\n';
        break;
      case 'h':
        out += '<h' + n.level + '>' + inline(n.text, refs, st, false, true).h + '</h' + n.level + '>\n';
        break;
      case 'code':
        out += '<pre><code' + (n.lang ? ' class="language-' + escText(n.lang) + '"' : '') + '>' + escEncode(n.text) + '</code></pre>\n';
        break;
      case 'html':
        out += n.text;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'quote':
        out += '<blockquote>\n' + renderBlocks(n.kids, refs, false, st) + '</blockquote>\n';
        break;
      case 'list': {
        out += n.ordered ? (n.start !== 1 ? '<ol start="' + n.start + '">\n' : '<ol>\n') : '<ul>\n';
        for (const item of n.items) {
          let itemNodes = item.nodes;
          let checkbox = null;
          const first = itemNodes[0];
          if (first && first.t === 'p' && /^\[[ xX]\][ \t]+\S/.test(first.text)) {
            checkbox = first.text[1] === ' ' ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">';
            itemNodes = [{ t: 'p', text: first.text.replace(/^\[[ xX]\][ \t]+/, '') }, ...itemNodes.slice(1)];
          }
          let inner = renderBlocks(itemNodes, refs, !n.loose, st);
          if (checkbox !== null) {
            if (inner.startsWith('<p>')) inner = '<p>' + checkbox + ' ' + inner.slice(3);
            else inner = checkbox + ' ' + inner;
          }
          out += '<li>' + inner + '</li>\n';
        }
        out += n.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < n.header.length; c++) {
          const al = n.aligns[c];
          out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inline(n.header[c], refs, st, false, true).h + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (n.rows.length) {
          out += '<tbody>';
          for (const row of n.rows) {
            out += '<tr>\n';
            for (let c = 0; c < n.header.length; c++) {
              const al = n.aligns[c];
              out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inline(row[c] || '', refs, st, false, true).h + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const endsNL = src.length > 0 && src[src.length - 1] === '\n';
  const lines = src.split('\n');
  if (endsNL) lines.pop();
  const nodes = parseBlocks(lines, 0, lines.length, refs, { eofNL: endsNL });
  const st = newInlineState();
  return renderBlocks(nodes, refs, false, st);
}
