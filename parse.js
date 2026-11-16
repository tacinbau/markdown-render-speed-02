// A fast Markdown renderer whose HTML is byte-identical to marked 18.1.3
// with its default options (GFM on, breaks off, pedantic off, async off).
// Written from scratch in this session: a block pass that collects link
// reference definitions and block structure, then a render pass that runs
// inline parsing (deferred, so definitions later in the document resolve).
// Inline parsing works on an index cursor over the original string (no
// per-token slicing) and renders straight to HTML strings.
//
// Design notes:
// - Emphasis / strikethrough decisions are taken against a MASKED copy of
//   the inline source (code spans, link spans and HTML blanked out), the
//   way marked does it; the mask preserves length so indices line up.
// - Block structure mirrors CommonMark/GFM as marked implements it; where
//   marked departs from the spec, marked's output wins.

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PCT25 = /%25/g;

// Escape HTML special chars. When `full` is true, every & is escaped;
// otherwise an & that already starts a valid entity reference is left alone.
function escHtml(s, full) {
  if (full) {
    return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (c) => ESC_MAP[c]) : s;
  }
  return ESC_TEST_NOENC.test(s) ? s.replace(ESC_REPLACE_NOENC, (c) => ESC_MAP[c]) : s;
}

// Decode numeric character references only; named entities stay verbatim
// (marked only decodes numeric ones here; `&word;` is left as-is).
function decodeNums(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
    if (cp === 38) return "&amp;";
    return String.fromCodePoint(cp);
  });
}

// Encode a URL the way marked does: encodeURI, then un-escape %25 back.
function cleanUrl(u) {
  try {
    return encodeURI(u).replace(PCT25, "%");
  } catch {
    return null;
  }
}

// Normalise a link label for lookup: trim, collapse whitespace, case-fold
// through upper-then-lower (marked's Unicode case-fold trick).
function normLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing char that balances `open`/`close` in `s`
// (backslash-escaped chars are skipped). Returns -1, or -2 when the string
// ends with an unclosed opener.
function findClose(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column `col` at the start of `s`.
function expandTabs(s, col) {
  let out = "";
  let c = col;
  for (const ch of s) {
    if (ch === "\t") {
      const n = 4 - (c % 4);
      out += " ".repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Drop trailing blank lines, keeping at most one blank line at the end.
function stripTrailingBlanks(s) {
  const lines = s.split("\n");
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join("\n");
}

// Remove `ch` characters from the end of `s` while they match (when
// `invert` is false) or while they differ (when true).
function trimEndChars(s, ch, invert) {
  let n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charAt(n - i - 1);
    if (c === ch && !invert) i++;
    else if (c !== ch && invert) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Split a table row on unescaped pipes, honouring the column count.
function splitRow(s, cols) {
  const t = s.replace(/\|/g, (ch, off, str) => {
    let esc = false;
    let p = off;
    while (--p >= 0 && str[p] === "\\") esc = !esc;
    return esc ? "|" : " |";
  });
  const cells = t.split(" |");
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (cols) {
    if (cells.length > cols) cells.splice(cols);
    else while (cells.length < cols) cells.push("");
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, "|");
  return cells;
}

// ---- regex construction -------------------------------------------------
// Patterns are built from string templates with named holes, the way the
// reference builds compound patterns. A `^` that lands at the start of a
// substituted source, or right after `(` or `|`, is dropped (it would
// otherwise anchor to the start of the whole string instead of the hole).
const CARET_STRIP = /(^|[^\[])\^/g;
function sub(template, holes) {
  let src = typeof template === "string" ? template : template.source;
  for (const key of Object.keys(holes)) {
    const val = holes[key];
    const piece = typeof val === "string" ? val : val.source;
    src = src.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), piece.replace(CARET_STRIP, "$1"));
  }
  return src;
}
function rx(src, flags) {
  return new RegExp(src, flags);
}
// Sticky version of a ^-anchored pattern: drop the leading ^, pin with /y.
function sticky(src, flags) {
  const s = typeof src === "string" ? src : src.source;
  return new RegExp(s.replace(/^\^/, ""), (flags || "") + "y");
}
// A factory that memoises a RegExp built from an indent level (0..3).
function levelFactory(build) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = build(k));
  };
}

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const COMMENT_RX = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---- block patterns ------------------------------------------------------
// Compound patterns are assembled from a template plus named pieces; a `^`
// inside a piece is dropped, matching the reference's builder behaviour.
function fill(template, pieces) {
  let s = template;
  for (const key of Object.keys(pieces)) {
    const piece = pieces[key].replace(CARET_STRIP, "$1");
    s = s.split(key).join(piece);
  }
  return s;
}

const HR_SRC = " {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)";
const HEAD_SRC = " {0,3}#{1,6}(?:\\s|$)";
const BULL_SRC = " {0,3}(?:[*+-]|\\d{1,9}[.)])";
const FENCE_LINE_SRC = " {0,3}(?:`{3,}|~{3,})";
const FENCE_PARA_SRC = " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)";
const QUOTE_SRC = " {0,3}>";
const CODE_INDENT_SRC = "(?: {4}| {0,3}\\t)";
const HTML_PARA_SRC =
  " {0,3}(?:</?(?:@TAG@)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)";
const HTML_BEGIN_SRC =
  " {0,3}(?:</?(?:@TAG@)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)";

const htmlParaSrc = fill(HTML_PARA_SRC, { "@TAG@": BLOCK_TAGS });
const htmlBeginSrc = fill(HTML_BEGIN_SRC, { "@TAG@": BLOCK_TAGS });

// Paragraph: a run of lines, none of which starts a block that interrupts.
const PARA_TMPL =
  "^([^\\n]+(?:\\n(?!@HR@|@HEAD@|@QUOTE@|@FENCE@|@LIST@|@HTML@|@TABLE@|[ \\t]+\\n)[^\\n]+)*)";
function paraSrc(listSrc, tableSrc) {
  let t = PARA_TMPL;
  if (!tableSrc) t = t.split("|@TABLE@").join("");
  return fill(t, {
    "@HR@": HR_SRC,
    "@HEAD@": HEAD_SRC,
    "@QUOTE@": QUOTE_SRC,
    "@FENCE@": FENCE_PARA_SRC,
    "@LIST@": listSrc,
    "@HTML@": htmlParaSrc,
    "@TABLE@": tableSrc || "",
  });
}

// Setext heading: text lines followed by an = or - underline.
const LH_TMPL =
  "^(?!@BULL@ |@CODE@|@FENCE@|@QUOTE@|@HEAD@|@HTML@|@TABLE@)((?:.|\\n(?!\\s*?\\n|@BULL@ |@FENCE@|@QUOTE@|@HEAD@|@HR@|@HTML@|@TABLE@))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)";
const HR_NC_SRC = " {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)";

function lheadingSrc(tableSrc) {
  let t = LH_TMPL;
  if (!tableSrc) t = t.split("|@TABLE@").join("");
  return fill(t, {
    "@BULL@": BULL_SRC,
    "@CODE@": CODE_INDENT_SRC,
    "@FENCE@": FENCE_LINE_SRC,
    "@QUOTE@": QUOTE_SRC,
    "@HEAD@": HEAD_SRC,
    "@HTML@": " {0,3}<[^\\n>]+>\\n",
    "@HR@": HR_NC_SRC,
    "@TABLE@": tableSrc || "",
  });
}

// Table: header line, delimiter line, then body rows.
const TABLE_TMPL =
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|@HR@|@HEAD@|@QUOTE@|@CODE@|@FENCE@|@LIST@|@HTML@).*(?:\\n|$))*)\\n*|$)";
const tableSrc = fill(TABLE_TMPL, {
  "@HR@": HR_SRC,
  "@HEAD@": HEAD_SRC,
  "@QUOTE@": QUOTE_SRC,
  "@CODE@": CODE_INDENT_SRC + "[^\\n]",
  "@FENCE@": FENCE_PARA_SRC,
  "@LIST@": " {0,3}(?:[*+-]|1[.)])[ \\t]",
  "@HTML@": htmlParaSrc,
});
const tableDelimSrc = " {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n";

// Link reference definition.
const DEF_LABEL_SRC = "(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+";
const DEF_TITLE_SRC =
  "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)";
const defSrc = fill(
  "^ {0,3}\\[(LABEL)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(TITLE))? *(?:\\n+|$)",
  { LABEL: DEF_LABEL_SRC, TITLE: DEF_TITLE_SRC },
);

// HTML block (type 1-7).
const HTML_BLOCK_SRC = fill(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|COMMENT[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(TAG)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  {
    COMMENT: COMMENT_RX.source,
    TAG: BLOCK_TAGS,
    ATTR: " +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?",
  },
);

// Blockquote: a run of `>` lines; the inner paragraph pattern is the
// paragraph builder with the list pattern a blockquote allows.
const quoteParaSrc = paraSrc(" {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)", "");
const blockquoteSrc = fill(
  "^((?: {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+)".replace(
    "PARA",
    "@PARA@",
  ),
  { "@PARA@": quoteParaSrc },
);

const BLOCK = {
  newline: sticky("^(?:[ \\t]*(?:\\n|$))+"),
  code: sticky("^((?: {4}| {0,3}\\t)[^\\n]+(?:\\n(?:[ \\t]*(?:\\n|$))*)?)+"),
  fences: sticky(
    "^ {0,3}(`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})([^\\n]*)(?:\\n|$)(?:|([\\s\\S]*?)(?:\\n|$))(?: {0,3}(?:(?=`)(\\1)`*|(?=~)(\\1)~*) *(?=\\n|$)|$)",
  ),
  heading: sticky("^ {0,3}(#{1,6})(?=\\s|$)(.*)(?:\\n+|$)"),
  hr: sticky("^ " + HR_SRC.slice(1)),
  html: sticky(HTML_BLOCK_SRC, "i"),
  lheading: sticky(lheadingSrc(tableDelimSrc)),
  list: sticky("^(" + BULL_SRC + ")([ \\t][^\\n]*?)?(?:\\n|$)"),
  def: sticky(defSrc),
  table: sticky(tableSrc),
  paragraph: sticky(paraSrc(" {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]", tableSrc)),
  blockquote: sticky(blockquoteSrc),
  text: sticky("^[^\\n]+"),
};
// The hr pattern above: HR_SRC already starts with " {0,3}"; keep it simple.
BLOCK.hr = sticky("^" + HR_SRC);

// One-line probes used while lexing list items (run against single lines).
const listItemRe = (bullet) => new RegExp(`( {0,3}${bullet})((?:[ \\t][^\\n]*)?(?:\\n|$))`, "y");
const nextBulletRe = levelFactory((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRe = levelFactory((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = levelFactory((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = levelFactory((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = levelFactory((n) => new RegExp(`^ {0,${n}}` + htmlBeginSrc.slice(6), "i"));
const blockquoteBeginRe = levelFactory((n) => new RegExp(`^ {0,${n}}>`));

const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeComp: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  leadingSpaceTab: /^[ \t]+/,
  tabCharGlobal: /\t/g,
  newLineGlobal: /\n/g,
  multipleSpaceGlobal: /\s+/g,
  endingNewline: /\n$/,
  notSpaceStart: /^\S*/,
  spaceLine: /^ +$/gm,
  setextLine: /^ {0,3}(?:=+|-+) *$/,
};

// ---- inline patterns -----------------------------------------------------
const PUNCT = "[\\p{P}\\p{S}]";
const PUNCT_SPACE = "[\\s\\p{P}\\p{S}]";
const NOT_PUNCT_SPACE = "[^\\s\\p{P}\\p{S}]";

const BRACKET_INNER = "\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_SRC =
  "(?:\\[(?:" + BRACKET_INNER + "|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?";
const LABEL_LT_SRC =
  "(?:[^\\[\\]\\\\`]*" +
  "(?:\\[(?:" + BRACKET_INNER + "|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]" +
  "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])" +
  ")){0,999}?[^\\[\\]\\\\`]*?";
const REF_SRC = "(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}";
const HREF_SRC = "<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))";
const TITLE_SRC = "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)";
const EMAIL_SRC =
  "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])";
const EMAIL_NOGROUP_SRC =
  "[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])";
const SCHEME_SRC = "[a-zA-Z][a-zA-Z0-9+.-]{1,31}";
const PROTO_SRC = "[hH][tT][tT][pP][sS]?|[fF][tT][pP]";

const INLINE = {
  escape: sticky("\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])"),
  code: sticky("(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)"),
  br: sticky("( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*"),
  tag: sticky(
    fill(
      "COMMENT|</[a-zA-Z][a-zA-Z0-9-]*\\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:ATTR)*?\\s*/?>|<\\?[\\s\\S]*?\\?>|<![a-zA-Z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
      {
        COMMENT: "<!--(?:-?>|[\\s\\S]*?-->)",
        ATTR: "\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?",
      },
    ),
  ),
  autolink: sticky("<(" + SCHEME_SRC + ":[^\\s\\x00-\\x1f<>]*|" + EMAIL_SRC + ")>"),
  link: sticky("!?\\[(" + LABEL_SRC + ")\\]\\([ \\t\\n]*(" + HREF_SRC + ")(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)((" + TITLE_SRC + ")))?[ \\t\\n]*\\)"),
  reflink: sticky("!?\\[(" + LABEL_LT_SRC + ")\\]\\[(" + REF_SRC + ")\\]"),
  nolink: sticky("!?\\[(" + REF_SRC + ")\\](?:\\[\\])?"),
  emLDelim: sticky(
    "(?:\\*+(?:((?!\\*)" + PUNCT + ")|([^\\s*]))?|_+(?:((?!_)" + PUNCT + ")|([^\\s_]))?)",
    "u",
  ),
  emRDelimAst: rx(
    "[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)" + PUNCT + "(\\*+)(?=[\\s]|$)|" +
    NOT_PUNCT_SPACE + "(\\*+)(?!\\*)(?=" + PUNCT_SPACE + "|$)|(?!\\*)" + PUNCT_SPACE + "(\\*+)(?=" + NOT_PUNCT_SPACE + ")|[\\s](\\*+)(?!\\*)(?=" + PUNCT + ")|(?!\\*)" + PUNCT + "(\\*+)(?!\\*)(?=" + PUNCT + ")|" + NOT_PUNCT_SPACE + "(\\*+)(?=" + NOT_PUNCT_SPACE + ")",
    "gu",
  ),
  emRDelimUnd: rx(
    "[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)" + PUNCT + "(_+)(?=[\\s]|$)|" +
    NOT_PUNCT_SPACE + "(_+)(?!_)(?=" + PUNCT_SPACE + "|$)|(?!_)" + PUNCT_SPACE + "(_+)(?=" + NOT_PUNCT_SPACE + ")|[\\s](_+)(?!_)(?=" + PUNCT + ")|(?!_)" + PUNCT + "(_+)(?!_)(?=" + PUNCT + ")",
    "gu",
  ),
  delLDelim: sticky("~~?(?:((?!~)" + PUNCT + ")|[^\\s~])", "u"),
  delRDelim: rx(
    "[^~]+(?=[^~])|(?!~)" + PUNCT + "(~~?)(?=[\\s]|$)|" +
    NOT_PUNCT_SPACE + "(~~?)(?!~)(?=" + PUNCT_SPACE + "|$)|(?!~)" + PUNCT_SPACE + "(~~?)(?=" + NOT_PUNCT_SPACE + ")|[\\s](~~?)(?!~)(?=" + PUNCT + ")|(?!~)" + PUNCT + "(~~?)(?!~)(?=" + PUNCT + ")|" + NOT_PUNCT_SPACE + "(~~?)(?=" + NOT_PUNCT_SPACE + ")",
    "gu",
  ),
  url: sticky(
    "((?:" + PROTO_SRC + "):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|(?:mailto:" + EMAIL_NOGROUP_SRC + "|xmpp:" + EMAIL_NOGROUP_SRC + "(?:\\/[A-Za-z0-9@.]+)?)|" + EMAIL_SRC,
  ),
  text: sticky(
    "(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|" + PROTO_SRC + ":\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{|}~-]+@))))",
  ),
  punctWord: sticky("((?![*_])" + PUNCT_SPACE + ")", "u"),
  unescape: new RegExp("\\\\(" + PUNCT + ")", "gu"),
};
const LINK_ANCHORED = new RegExp("^" + INLINE.link.source);
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Mask helpers: blank out reference links, code spans, links and HTML so
// emphasis decisions are taken on the masked source, as marked does.
const LINK_SKIP_SRC =
  "\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)";
const CODE_SKIP_SRC = "(?<b>`+)[^`]+\\k<b>(?!`)";
const BLOCK_SKIP_SRC = "(?:" + LINK_SKIP_SRC + "|(?<!`)()" + CODE_SKIP_SRC + "|<(?! )[^<>]*?>)";
const blockSkipRe = new RegExp(BLOCK_SKIP_SRC, "g");
const REFLINK_SEARCH_SRC =
  "(?:!?\\[(" + LABEL_LT_SRC + ")\\]\\[(" + REF_SRC + ")\\]|!?\\[(" + REF_SRC + ")\\](?:\\[\\])?(?!\\())";
const reflinkSearchRe = new RegExp(REFLINK_SEARCH_SRC, "g");
const ANY_PUNCT_OUTSIDE_CODE = new RegExp(
  "(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(" + PUNCT + ")",
  "gu",
);

// Does `src` contain a link (inline or reference) anywhere? Used while
// masking reference links whose label itself holds a link.
function linkInText(src, links) {
  if (!src.includes("[")) return false;
  for (const m of src.matchAll(blockSkipRe)) {
    if (LINK_ANCHORED.test(m[0]) && src.charAt(m.index - 1) !== "!") return true;
  }
  for (const m of src.matchAll(reflinkSearchRe)) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    if (
      !(s.charAt(0) === "!" || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(s.slice(1, r - 1), links))
    ) {
      return true;
    }
  }
  return false;
}

// Blank a reference-link span in the mask, recursing into a label that
// itself contains a link (so nested references mask correctly).
function maskRefSpan(m, links) {
  const o = m.lastIndexOf("[");
  if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
  if (o > 1 && m.charAt(0) !== "!") {
    const inner = m.slice(1, o - 1);
    if (linkInText(inner, links)) {
      return (
        "[" +
        inner.replace(new RegExp(REFLINK_SEARCH_SRC, "g"), (x) => maskRefSpan(x, links)) +
        "][" +
        "a".repeat(m.length - o - 2) +
        "]"
      );
    }
  }
  return "[" + "a".repeat(m.length - 2) + "]";
}

// The masked copy of an inline source: reference links whose target is
// defined are blanked, then code spans lose their inner backticks and
// backslash-escaped punctuation becomes `+`, then link / code / HTML spans
// are blanked to `[aaa...]`. Length is preserved throughout. Each pass is
// skipped when the source cannot contain what it looks for.
function buildMask(src, links) {
  let t = src;
  if (links && src.includes("[")) {
    t = t.replace(reflinkSearchRe, (m) => maskRefSpan(m, links));
  }
  if (t.includes("`") || t.includes("\\")) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (m, bt, punct) =>
      punct
        ? "+".repeat(m.length)
        : bt
          ? bt + m.slice(bt.length, -bt.length).replace(/`/g, "+") + bt
          : m,
    );
  }
  if (t.includes("[") || t.includes("<") || t.includes("`")) {
    t = t.replace(blockSkipRe, (m) => "[" + "a".repeat(m.length - 2) + "]");
  }
  return t;
}

// Last positions in the masked source where an emphasis / strikethrough
// run may close: a run whose preceding character is not whitespace.
function scanClosers(mask) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  const n = mask.length;
  for (let s = 0; s < n; s++) {
    const ch = mask[s];
    if (ch !== "*" && ch !== "_" && ch !== "~") continue;
    const prev = s === 0 ? "\n" : mask[s - 1];
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r" && prev !== "\f") {
      if (ch === "~") tilde = s;
      else if (ch === "*") star = s;
      else under = s;
    }
    let i = s + 1;
    while (i < n && mask[i] === ch) i++;
    s = i - 1;
  }
  return { star, under, tilde };
}

// ---- inline engine -------------------------------------------------------
// State shared across the inline runs of one parse() call. `inLink` and
// `linkEmitted` persist between blocks (marked only resets `inRawBlock`
// per queued inline run); `linkParenPossible` is saved/restored per run.
function newInlineState() {
  return { inLink: false, linkEmitted: false, inRawBlock: false, linkParenPossible: true };
}

const PUNCT_WORD_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

// Does the link label `label` (starting at offset `off` inside the remaining
// source `src`) contain a `<` that opens a tag/autolink running past the
// end of the label? Such a link is not a link at all.
function hasTagAfter(src, label, off) {
  if (!label.includes("<")) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === "\\") { s++; continue; }
    if (label[s] === "`") {
      INLINE.code.lastIndex = s;
      const m = INLINE.code.exec(label);
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== "<") continue;
    INLINE.tag.lastIndex = off + s;
    let o = INLINE.tag.exec(src);
    if (!o) {
      INLINE.autolink.lastIndex = off + s;
      o = INLINE.autolink.exec(src);
    }
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Render the label of a link/image and apply marked's nested-link rules.
// Returns null when a non-image link's label itself emitted a link (the
// outer link is suppressed); otherwise {isImage, html, plain, rawLen} where
// `plain` is the label rendered as plain text (for an image's alt text).
function finishLink(m, href, title, links, st, mode) {
  const labelText = m[1].replace(RE.outputLinkReplace, "$1");
  const isImage = m[0].charAt(0) === "!";
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const label = inlineRun(labelText, links, st, isImage ? 2 : mode);
  const nestedEmitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (nestedEmitted) {
      st.inRawBlock = savedRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  const labelHtml = typeof label === "string" ? label : label.h;
  const labelPlain = typeof label === "string" ? label : label.p;
  return { isImage, href, title, labelHtml, labelPlain, rawLen: m[0].length };
}

// Emphasis / strong emphasis at `pos` in `src` (mask = masked full source).
// Returns {kind, rawLen, inner} or null.
function tryEmStrong(src, pos, mask, closers, prevChar) {
  INLINE.emLDelim.lastIndex = pos;
  const m = INLINE.emLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  let l = pos;
  while (l > 0 && mask[l - 1] === delim) l--;
  let p = "";
  if (l > 0) {
    const seg = [...mask.slice(Math.max(0, l - 2), l)];
    p = seg[seg.length - 1] ?? "";
  }
  const h = p === "*" || p === "_" || PUNCT_WORD_RE.test(p);
  let n2 = prevChar;
  if (l < pos) n2 = p;
  const u = l < pos ? h : PUNCT_WORD_RE.test(prevChar);
  if (m[4] && ALNUM_RE.test(n2)) return null;
  const d = m[1] || m[3] || "";
  if (!d || !n2 || u) {
    const k = [...m[0]].length - 1;
    let rem = k;
    let extra = 0;
    const y = pos - l + k;
    const canRule3 = !!p.trim() && (!!d || (delim === "*" && !h));
    if (delim !== "*" && delim !== "_") return null;
    const closerRe = delim === "*" ? INLINE.emRDelimAst : INLINE.emRDelimUnd;
    const v = delim === "*" ? closers.star : closers.under;
    const q = pos + k;
    if (v < q) return null;
    closerRe.lastIndex = q;
    for (;;) {
      const s = closerRe.exec(mask);
      if (!s || s.index > v) break;
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) {
        // A group-less match is a skip. The first alternative (the
        // `__...*...__` / `**..._...**` skip-ahead) is anchored to the
        // start of the scan in the reference, so a skip that starts later
        // and spans a delimiter can only be that alternative: do not let
        // it swallow a closer, retry one character on.
        if (s.index !== q && s[0].includes(delim)) {
          closerRe.lastIndex = s.index + 1;
        }
        continue;
      }
      const b = [...g].length;
      if (s[3] || s[4]) { rem += b; continue; }
      if (s[5] || s[6] || canRule3) {
        if (sameAsPrev && (s[5] || s[6])) break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { extra += b; continue; }
      }
      rem -= b;
      if (rem > 0) continue;
      const take = Math.min(b, b + rem + extra);
      const te = [...s[0]][0].length;
      const end = s.index + te + take;
      const raw = src.slice(pos, end);
      if (Math.min(k, take) % 2 === 1) {
        return { kind: "em", rawLen: raw.length, inner: raw.slice(1, -1) };
      }
      return { kind: "strong", rawLen: raw.length, inner: raw.slice(2, -2) };
    }
  }
  return null;
}

// Strikethrough at `pos` (GFM `~~text~~`).
function tryDel(src, pos, mask, tildeCloser, prevChar) {
  INLINE.delLDelim.lastIndex = pos;
  const m = INLINE.delLDelim.exec(src);
  if (!m) return null;
  if (m[1] && prevChar && !PUNCT_WORD_RE.test(prevChar)) return null;
  const runLen = [...m[0]].length - 1;
  let rem = runLen;
  const d = pos + runLen;
  if (tildeCloser < d) return null;
  INLINE.delRDelim.lastIndex = d;
  for (;;) {
    const s = INLINE.delRDelim.exec(mask);
    if (!s || s.index > tildeCloser) break;
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let len = [...g].length;
    if (len !== runLen) continue;
    if (s[3] || s[4]) { rem += len; continue; }
    rem -= len;
    if (rem > 0) continue;
    len = Math.min(len, len + rem);
    const firstLen = [...s[0]][0].length;
    const end = s.index + firstLen + len;
    const raw = src.slice(pos, end);
    return { kind: "del", rawLen: raw.length, inner: raw.slice(runLen, -runLen) };
  }
  return null;
}

// Inline link `[label](href "title")` at `pos`, or null.
function tryLink(src, pos, links, st, mode) {
  if (!st.linkParenPossible) return null;
  INLINE.link.lastIndex = pos;
  const m = INLINE.link.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === "!";
  const off = bang ? 2 : 1;
  if (hasTagAfter(src, m[1], pos + off)) return null;
  if (m[2].charAt(0) === "<") {
    if (m[2].charAt(m[2].length - 1) !== ">") return null;
    const stripped = trimEndChars(m[2].slice(0, -1), "\\", false);
    if ((m[2].length - stripped.length) % 2 === 0) return null;
  } else {
    const closeIdx = findClose(m[2], "(", ")");
    if (closeIdx === -2) return null;
    if (closeIdx > -1) {
      const h = (bang ? 5 : 4) + m[1].length + closeIdx;
      m[2] = m[2].substring(0, closeIdx);
      m[0] = m[0].substring(0, h).trim();
      m[3] = "";
    }
  }
  const tail = trimEndChars(m[0].slice(0, -1), "\\", false);
  if ((m[0].length - tail.length) % 2 === 0) return null;
  let href = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : "";
  if (href.charAt(0) === "<") href = href.slice(1, -1);
  return finishLink(
    m,
    href ? href.replace(INLINE.unescape, "$1") : href,
    title ? title.replace(INLINE.unescape, "$1") : title,
    links,
    st,
    mode,
  );
}

// Reference link `[label][ref]` / `[label][]` / `[label]` at `pos`, or null.
// When the reference is undefined it consumes just the first character
// as plain text (marked's reflink fallback).
function tryReflink(src, pos, links, st, mode) {
  INLINE.reflink.lastIndex = pos;
  let m = INLINE.reflink.exec(src);
  if (!m) {
    INLINE.nolink.lastIndex = pos;
    m = INLINE.nolink.exec(src);
  }
  if (!m) return null;
  const bang = m[0].charAt(0) === "!";
  const off = bang ? 2 : 1;
  if (hasTagAfter(src, m[1], pos + off)) return null;
  const def = links[normLabel(m[2] || m[1])];
  if (!def) return { kind: "text", text: m[0].charAt(0), rawLen: 1 };
  return finishLink(m, def.href, def.title || "", links, st, mode);
}

// `<scheme:...>` / `<email>` autolink at `pos`, or null.
function tryAutolink(src, pos) {
  INLINE.autolink.lastIndex = pos;
  const m = INLINE.autolink.exec(src);
  if (!m) return null;
  const text = m[1];
  const href = m[2] === "@" ? "mailto:" + text : text;
  return { kind: "link", auto: true, href, text, rawLen: m[0].length };
}

// GFM extended autolink (www. / protocol / email) at `pos`, or null.
function tryUrl(src, pos) {
  INLINE.url.lastIndex = pos;
  const m = INLINE.url.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[0];
    href = "mailto:" + text;
  } else {
    let raw = m[0];
    let prev;
    do {
      prev = raw;
      raw = BACKPEDAL.exec(raw)?.[0] ?? "";
    } while (prev !== raw);
    text = raw;
    href = m[1] === "www." ? "http://" + raw : raw;
  }
  return { kind: "link", auto: true, href, text, rawLen: text.length };
}

// Characters that can start an extended autolink / email address.
const EMAIL_CLASS = new Uint8Array(128);
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") {
  EMAIL_CLASS[c.charCodeAt(0)] = 1;
}

// Render inline markdown to HTML (`mode` 0) or to both HTML and plain text
// (`mode` 2, used for image labels, whose alt text is the plain rendering).
// Returns a string in mode 0, or {h, p} in mode 2.
// Case-insensitive prefix test without allocating a lowercased slice.
function startsWithLower(src, pos, lit) {
  for (let i = 0; i < lit.length; i++) {
    const c = src.charCodeAt(pos + i);
    if (c !== lit.charCodeAt(i) && (c | 32) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// Fast path for a whole inline source with no markup at all: plain text
// with no backslash, tag, link, emphasis, code, strike or URL trigger.
const NO_MARKUP_RE = /[\\<\[!*_`~]|  \n|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:|@/i;

function inlineRun(src, links, st, mode) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(")");
  let mask = null;
  let closers = null;
  if (src.includes("*") || src.includes("_") || src.includes("~")) {
    mask = buildMask(src, links);
    closers = scanClosers(mask);
  }
  const both = mode === 2;
  // Fast path: a whole inline source with no markup at all is one plain
  // text run — decode and escape it in a single pass instead of tokenizing.
  if (!st.inRawBlock && !NO_MARKUP_RE.test(src)) {
    const decoded = decodeNums(src);
    st.linkParenPossible = savedParen;
    return both ? { h: escHtml(decoded), p: decoded } : escHtml(decoded);
  }
  const n = src.length;
  let outH = "";
  let outP = "";
  let pos = 0;
  let prevChar = "";
  let justText = false;
  // Cached scan for the next `@` inside the current run of email-class
  // characters, so deciding whether a URL/email can start here stays O(1)
  // amortised instead of re-scanning a long word at every position.
  let atEnd = -1;
  let atHas = false;
  const emailAhead = (p) => {
    if (p < atEnd) return atHas;
    let i = p;
    while (i < n && src.charCodeAt(i) < 128 && EMAIL_CLASS[src.charCodeAt(i)]) i++;
    atEnd = i;
    atHas = i < n && src[i] === "@";
    return atHas;
  };
  while (pos < n) {
    const before = pos;
    if (!justText) prevChar = "";
    justText = false;
    const ch = src[pos];
    let consumed = 0;
    if (ch === "\\") {
      INLINE.escape.lastIndex = pos;
      const m = INLINE.escape.exec(src);
      if (m) {
        outH += escHtml(m[1]);
        if (both) outP += m[1];
        consumed = m[0].length;
      } else {
        INLINE.br.lastIndex = pos;
        const b = INLINE.br.exec(src);
        if (b) {
          outH += "<br>";
          consumed = b[0].length;
        }
      }
    } else if (ch === "<") {
      INLINE.tag.lastIndex = pos;
      const m = INLINE.tag.exec(src);
      if (m) {
        const tag = m[0];
        if (!st.inLink && RE.startATag.test(tag)) st.inLink = true;
        else if (st.inLink && RE.endATag.test(tag)) st.inLink = false;
        if (!st.inRawBlock && RE.startPreScriptTag.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && RE.endPreScriptTag.test(tag)) st.inRawBlock = false;
        outH += tag;
        if (both) outP += tag;
        consumed = tag.length;
      } else {
        const a = tryAutolink(src, pos);
        if (a) {
          const u = cleanUrl(a.href);
          if (u === null) {
            outH += escHtml(a.text, true);
          } else {
            outH += '<a href="' + escHtml(u, true) + '">' + escHtml(a.text, true) + "</a>";
          }
          if (both) outP += a.text;
          consumed = a.rawLen;
        }
      }
    } else if (ch === "[" || ch === "!") {
      const lk = tryLink(src, pos, links, st, mode);
      if (lk && lk.kind !== "text") {
        if (lk.isImage) {
          const u = cleanUrl(lk.href);
          if (u === null) {
            outH += escHtml(lk.labelPlain);
          } else {
            outH +=
              '<img src="' + escHtml(u) + '" alt="' + escHtml(lk.labelPlain) + '"' +
              (lk.title ? ' title="' + escHtml(lk.title) + '"' : "") + ">";
          }
          if (both) outP += lk.labelPlain;
        } else {
          const u = cleanUrl(lk.href);
          if (u === null) {
            outH += lk.labelHtml;
          } else {
            outH +=
              '<a href="' + escHtml(u) + '"' +
              (lk.title ? ' title="' + escHtml(lk.title) + '"' : "") +
              ">" + lk.labelHtml + "</a>";
          }
          if (both) outP += lk.labelPlain;
        }
        consumed = lk.rawLen;
      } else if (lk) {
        outH += lk.text;
        if (both) outP += lk.text;
        consumed = 1;
      } else {
        const rl = tryReflink(src, pos, links, st, mode);
        if (rl) {
          if (rl.kind === "text") {
            outH += rl.text;
            if (both) outP += rl.text;
            consumed = 1;
          } else if (rl.isImage) {
            const u = cleanUrl(rl.href);
            if (u === null) {
              outH += escHtml(rl.labelPlain);
            } else {
              outH +=
                '<img src="' + escHtml(u) + '" alt="' + escHtml(rl.labelPlain) + '"' +
                (rl.title ? ' title="' + escHtml(rl.title) + '"' : "") + ">";
            }
            if (both) outP += rl.labelPlain;
            consumed = rl.rawLen;
          } else {
            const u = cleanUrl(rl.href);
            if (u === null) {
              outH += rl.labelHtml;
            } else {
              outH +=
                '<a href="' + escHtml(u) + '"' +
                (rl.title ? ' title="' + escHtml(rl.title) + '"' : "") +
                ">" + rl.labelHtml + "</a>";
            }
            if (both) outP += rl.labelPlain;
            consumed = rl.rawLen;
          }
        }
      }
    } else if (ch === "*" || ch === "_") {
      const em = tryEmStrong(src, pos, mask, closers, prevChar);
      if (em) {
        const inner = inlineRun(em.inner, links, st, mode);
        const innerH = both ? inner.h : inner;
        const innerP = both ? inner.p : inner;
        if (em.kind === "em") {
          outH += "<em>" + innerH + "</em>";
          if (both) outP += innerP;
        } else {
          outH += "<strong>" + innerH + "</strong>";
          if (both) outP += innerP;
        }
        consumed = em.rawLen;
      }
    } else if (ch === "`") {
      INLINE.code.lastIndex = pos;
      const m = INLINE.code.exec(src);
      if (m) {
        let content = m[2].replace(RE.newLineGlobal, " ");
        if (RE.nonSpaceChar.test(content) && content.charAt(0) === " " && content.charAt(content.length - 1) === " ") {
          content = content.substring(1, content.length - 1);
        }
        outH += "<code>" + escHtml(content, true) + "</code>";
        if (both) outP += content;
        consumed = m[0].length;
      }
    } else if (ch === " ") {
      INLINE.br.lastIndex = pos;
      const b = INLINE.br.exec(src);
      if (b) {
        outH += "<br>";
        consumed = b[0].length;
      }
    } else if (ch === "~") {
      const d = tryDel(src, pos, mask, closers.tilde, prevChar);
      if (d) {
        const inner = inlineRun(d.inner, links, st, mode);
        const innerH = both ? inner.h : inner;
        const innerP = both ? inner.p : inner;
        outH += "<del>" + innerH + "</del>";
        if (both) outP += innerP;
        consumed = d.rawLen;
      }
    }
    if (!consumed && !st.inLink) {
      const code = ch.charCodeAt(0);
      if (
        code < 128 && EMAIL_CLASS[code] &&
        ((ch === "w" && src.startsWith("www.", pos)) ||
          ((ch === "h" || ch === "H") &&
            (startsWithLower(src, pos, "http://") ||
              startsWithLower(src, pos, "https://"))) ||
          ((ch === "f" || ch === "F") && startsWithLower(src, pos, "ftp://")) ||
          (ch === "m" && src.startsWith("mailto:", pos)) ||
          (ch === "x" && src.startsWith("xmpp:", pos)) ||
          emailAhead(pos))
      ) {
        const u = tryUrl(src, pos);
        if (u) {
          const clean = cleanUrl(u.href);
          if (clean === null) {
            outH += escHtml(u.text, true);
          } else {
            outH += '<a href="' + escHtml(clean, true) + '">' + escHtml(u.text, true) + "</a>";
          }
          if (both) outP += u.text;
          consumed = u.rawLen;
        }
      }
    }
    if (!consumed) {
      INLINE.text.lastIndex = pos;
      const m = INLINE.text.exec(src);
      if (m) {
        const chunk = m[0];
        if (st.inRawBlock) {
          outH += chunk;
          if (both) outP += chunk;
        } else {
          const decoded = decodeNums(chunk);
          outH += escHtml(decoded);
          if (both) outP += decoded;
        }
        if (chunk.charAt(chunk.length - 1) !== "_") prevChar = chunk.charAt(chunk.length - 1);
        justText = true;
        consumed = chunk.length;
      }
    }
    if (consumed === 0) {
      throw new Error("Infinite loop on byte: " + src.charCodeAt(pos));
    }
    pos += consumed;
    if (pos === before) throw new Error("Infinite loop on byte: " + src.charCodeAt(pos));
  }
  st.linkParenPossible = savedParen;
  return both ? { h: outH, p: outP } : outH;
}

// ---- block lexer ---------------------------------------------------------
// Block nodes: {k} is the kind. `txt` is the inline source for kinds that
// render inline content; `raw` is the source slice a node consumed (kept
// where a parent re-lexes it, e.g. blockquote/list). Rendering happens in
// a separate pass, after the whole document is lexed, so link reference
// definitions anywhere in the document resolve.

function fenceIndentComp(fenceRaw, content) {
  const m = RE.indentCodeComp.exec(fenceRaw);
  if (!m) return content;
  const indent = m[1];
  return content
    .split("\n")
    .map((line) => {
      const sp = RE.beginningSpace.exec(line);
      if (!sp) return line;
      return line.slice(Math.min(sp[0].length, indent.length));
    })
    .join("\n");
}

const HR_TEST_RE = new RegExp("^" + HR_SRC);
const LH_TEST_RE = new RegExp("^" + lheadingSrc(tableDelimSrc));

// Each tokenizer takes (s, pos, links) and returns [node, consumed] or null.
function tokSpace(s, pos) {
  BLOCK.newline.lastIndex = pos;
  const m = BLOCK.newline.exec(s);
  if (m && m[0].length > 0) return [{ k: "space", raw: m[0] }, m[0].length];
  return null;
}

function tokCode(s, pos) {
  BLOCK.code.lastIndex = pos;
  const m = BLOCK.code.exec(s);
  if (!m) return null;
  const raw = stripTrailingBlanks(m[0]);
  const txt = raw.replace(RE.codeRemoveIndent, "");
  return [{ k: "code", txt, lang: undefined }, raw.length];
}

function tokFences(s, pos) {
  BLOCK.fences.lastIndex = pos;
  const m = BLOCK.fences.exec(s);
  if (!m) return null;
  const lang = m[2] ? m[2].trim().replace(INLINE.unescape, "$1") : m[2];
  const txt = fenceIndentComp(m[0], m[3] || "");
  return [{ k: "code", txt, lang }, m[0].length];
}

function tokHeading(s, pos) {
  BLOCK.heading.lastIndex = pos;
  const m = BLOCK.heading.exec(s);
  if (!m) return null;
  let txt = m[2].trim();
  if (RE.endingHash.test(txt)) {
    const stripped = trimEndChars(txt, "#", false);
    if (!stripped || RE.endingSpaceTabChar.test(stripped)) txt = stripped.trim();
  }
  return [{ k: "head", d: m[1].length, txt }, trimEndChars(m[0], "\n", false).length];
}

function tokHr(s, pos) {
  BLOCK.hr.lastIndex = pos;
  const m = BLOCK.hr.exec(s);
  if (!m) return null;
  return [{ k: "hr" }, trimEndChars(m[0], "\n", false).length];
}

function tokHtml(s, pos) {
  BLOCK.html.lastIndex = pos;
  const m = BLOCK.html.exec(s);
  if (!m) return null;
  const txt = stripTrailingBlanks(m[0]);
  return [{ k: "html", txt, pre: m[1] === "pre" || m[1] === "script" || m[1] === "style" }, txt.length];
}

function tokDef(s, pos) {
  BLOCK.def.lastIndex = pos;
  const m = BLOCK.def.exec(s);
  if (!m) return null;
  if (m[2].charAt(0) !== "<" && findClose(m[2], "(", ")") !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2]
    ? m[2].replace(RE.hrefBrackets, "$1").replace(INLINE.unescape, "$1")
    : "";
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.unescape, "$1") : m[3];
  return [{ k: "def", tag, href, title }, trimEndChars(m[0], "\n", false).length];
}

function tokTable(s, pos) {
  BLOCK.table.lastIndex = pos;
  const m = BLOCK.table.exec(s);
  if (!m || !RE.tableDelimiter.test(m[2])) return null;
  const headCells = splitRow(m[1]);
  const delimCells = m[2].replace(RE.tableAlignChars, "").split("|");
  const bodyRows = m[3] && m[3].trim() ? m[3].replace(RE.tableRowBlankLine, "").split("\n") : [];
  if (headCells.length !== delimCells.length) return null;
  const align = delimCells.map((c) =>
    RE.tableAlignRight.test(c)
      ? "right"
      : RE.tableAlignCenter.test(c)
        ? "center"
        : RE.tableAlignLeft.test(c)
          ? "left"
          : null,
  );
  const head = headCells.map((txt, i) => ({ txt, al: align[i] }));
  const rows = bodyRows.map((row) =>
    splitRow(row, head.length).map((txt, i) => ({ txt, al: align[i] })),
  );
  return [{ k: "table", head, rows }, trimEndChars(m[0], "\n", false).length];
}

function tokLheading(s, pos) {
  BLOCK.lheading.lastIndex = pos;
  const m = BLOCK.lheading.exec(s);
  if (!m) return null;
  const txt = m[1].trim();
  return [{ k: "head", d: m[2].charAt(0) === "=" ? 1 : 2, txt }, trimEndChars(m[0], "\n", false).length];
}

function tokParagraph(s, pos) {
  BLOCK.paragraph.lastIndex = pos;
  const m = BLOCK.paragraph.exec(s);
  if (!m) return null;
  const txt = m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
  return [{ k: "para", txt }, m[0].length];
}

function tokText(s, pos) {
  BLOCK.text.lastIndex = pos;
  const m = BLOCK.text.exec(s);
  if (!m) return null;
  return [{ k: "text", txt: m[0] }, m[0].length];
}

// Lex block structure into `nodes` (appended to), consuming all of `s`.
// `ctx.top` decides whether a paragraph may start here; it is set true
// on return, as in the reference. `join` merges the first paragraph of
// this call into a preceding paragraph node (blockquote continuations).
function lexBlocks(s, links, ctx, join, nodes) {
  let pos = 0;
  const n = s.length;
  let guard = Infinity;
  while (pos < n) {
    const remaining = n - pos;
    if (remaining < guard) guard = remaining;
    else throw new Error("Infinite loop on byte: " + s.charCodeAt(pos));
    let hit = tokSpace(s, pos);
    if (hit) {
      // A one-character blank (a single newline) is folded into the
      // previous token instead of becoming its own node, so text tokens
      // on either side of it still merge into one.
      if (!(hit[1] === 1 && nodes.length > 0)) nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokCode(s, pos);
    if (hit) {
      const last = nodes[nodes.length - 1];
      if (last && (last.k === "para" || last.k === "text")) {
        last.txt += "\n" + hit[0].txt;
      } else {
        nodes.push(hit[0]);
      }
      pos += hit[1];
      continue;
    }
    hit = tokFences(s, pos);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokHeading(s, pos);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokHr(s, pos);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokBlockquote(s, pos, links, ctx);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokList(s, pos, links, ctx);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokHtml(s, pos);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokDef(s, pos);
    if (hit) {
      const last = nodes[nodes.length - 1];
      if (last && (last.k === "para" || last.k === "text")) {
        last.txt += "\n" + s.slice(pos, pos + hit[1]);
      } else {
        if (!Object.hasOwn(links, hit[0].tag)) {
          links[hit[0].tag] = { href: hit[0].href, title: hit[0].title };
        }
        nodes.push(hit[0]);
      }
      pos += hit[1];
      continue;
    }
    hit = tokTable(s, pos);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    hit = tokLheading(s, pos);
    if (hit) {
      nodes.push(hit[0]);
      pos += hit[1];
      continue;
    }
    if (ctx.top) {
      hit = tokParagraph(s, pos);
      if (hit) {
        const last = nodes[nodes.length - 1];
        if (join && last && last.k === "para") {
          last.txt += "\n" + hit[0].txt;
        } else {
          nodes.push(hit[0]);
        }
        join = false;
        pos += hit[1];
        continue;
      }
    }
    hit = tokText(s, pos);
    if (hit) {
      const last = nodes[nodes.length - 1];
      if (last && last.k === "text") {
        last.txt += "\n" + hit[0].txt;
      } else {
        nodes.push(hit[0]);
      }
      pos += hit[1];
      continue;
    }
    throw new Error("Infinite loop on byte: " + s.charCodeAt(pos));
  }
  ctx.top = true;
  return nodes;
}

// First line of `s` starting at `pos` (without its newline).
function firstLine(s, pos) {
  const i = s.indexOf("\n", pos);
  return i === -1 ? s.slice(pos) : s.slice(pos, i);
}

function tokBlockquote(s, pos, links, ctx) {
  BLOCK.blockquote.lastIndex = pos;
  const m = BLOCK.blockquote.exec(s);
  if (!m) return null;
  let lines = trimEndChars(m[0], "\n", false).split("\n");
  let rawOut = "";
  let textOut = "";
  const kids = [];
  while (lines.length > 0) {
    let seen = false;
    const chunkLines = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (RE.blockquoteStart.test(lines[p])) {
        chunkLines.push(lines[p]);
        seen = true;
      } else if (!seen) chunkLines.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const chunk = chunkLines.join("\n");
    const stripped = chunk
      .replace(RE.blockquoteMarkerWs, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(RE.blockquoteSetextReplace, "\n    $1")
      .replace(RE.blockquoteSetextReplace2, "");
    rawOut = rawOut ? rawOut + "\n" + chunk : chunk;
    textOut = textOut ? textOut + "\n" + stripped : stripped;
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(stripped, links, ctx, true, kids);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = kids[kids.length - 1];
    if (
      last &&
      (last.k === "code" || last.k === "head" || last.k === "hr" || last.k === "html" || last.k === "table")
    ) {
      break;
    }
    if (last && last.k === "quote") {
      const rest = lines.join("\n");
      const combined = last.raw + "\n" + rest.replace(RE.blockquoteSetextReplace2, "");
      const re = tokBlockquote(combined, 0, links, ctx);
      if (!re) break;
      kids[kids.length - 1] = re[0];
      const y = combined.substring(re[0].raw.length).replace(/^\n/, "");
      const r = y ? y.split("\n").length : 0;
      const taken = r ? lines.slice(0, -r) : lines;
      if (taken.length > 0) rawOut += "\n" + taken.join("\n");
      textOut = textOut.substring(0, textOut.length - last.txt.length) + re[0].txt;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last && last.k === "list") {
      const combined = last.raw + "\n" + lines.join("\n");
      const re = tokList(combined, 0, links, ctx);
      if (!re) break;
      kids[kids.length - 1] = re[0];
      const f =
        re[0].raw.length > last.raw.length
          ? combined.slice(last.raw.length + 1, re[0].raw.length).split("\n").length
          : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join("\n");
        rawOut += "\n" + y;
        textOut += "\n" + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return [{ k: "quote", kids, txt: textOut, raw: rawOut }, rawOut.length];
}

function tokList(s, pos, links, ctx) {
  BLOCK.list.lastIndex = pos;
  const m = BLOCK.list.exec(s);
  if (!m) return null;
  const startPos = pos;
  const bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const node = {
    k: "list",
    ord: ordered,
    start: ordered ? +bullet.slice(0, -1) : "",
    loose: false,
    items: [],
    raw: "",
  };
  const bulletSrc = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRe(bulletSrc);
  let p = false;
  let cur = pos;
  const n = s.length;
  while (cur < n) {
    let blankItem = false;
    let d = "";
    itemRe.lastIndex = cur;
    const im = itemRe.exec(s);
    BLOCK.hr.lastIndex = cur;
    if (!im || BLOCK.hr.exec(s)) break;
    const itemStart = cur;
    cur += im[0].length;
    const g = im[2] ? im[2].split("\n", 1)[0] : "";
    const b = im[1].length;
    let line1 = g.replace(RE.leadingSpaceTab, (v) => expandTabs(v, b));
    let f = firstLine(s, cur);
    const y0 = !line1.trim();
    let indent;
    if (y0) {
      indent = b + 1;
    } else {
      indent = line1.search(RE.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      d = line1.slice(indent);
      indent += b;
    }
    let y = y0;
    if (y && RE.blankLine.test(f)) {
      cur += f.length + 1;
      blankItem = true;
    }
    if (!blankItem) {
      const nextB = nextBulletRe(indent);
      const hrR = hrRe(indent);
      const fenR = fencesBeginRe(indent);
      const headR = headingBeginRe(indent);
      const htmlR = htmlBeginRe(indent);
      const quoteR = blockquoteBeginRe(indent);
      while (cur < n) {
        const line = firstLine(s, cur);
        f = line;
        const expanded = f.replace(RE.leadingSpaceTab, (me) => expandTabs(me, 0));
        if (
          fenR.test(f) ||
          headR.test(f) ||
          htmlR.test(f) ||
          quoteR.test(f) ||
          nextB.test(f) ||
          hrR.test(f)
        ) {
          break;
        }
        if (expanded.search(RE.nonSpaceChar) >= indent || !f.trim()) {
          d += "\n" + expanded.slice(indent);
        } else {
          if (
            y ||
            line1.replace(RE.tabCharGlobal, "    ").search(RE.nonSpaceChar) >= 4 ||
            fenR.test(line1) ||
            headR.test(line1) ||
            htmlR.test(line1) ||
            hrR.test(line1)
          ) {
            break;
          }
          const qe =
            RE.setextLine.test(f) && LH_TEST_RE.test(line1 + "\n" + f)
              ? "    " + expanded.replace(/^ {0,3}/, "")
              : f;
          d += "\n" + qe;
        }
        y = !f.trim();
        cur += line.length + 1;
        line1 = expanded.slice(indent);
      }
    }
    const itemRaw = s.slice(itemStart, cur);
    if (!node.loose) {
      if (p) node.loose = true;
      else if (RE.doubleBlankLine.test(itemRaw)) p = true;
    }
    node.items.push({ txt: d, raw: itemRaw, task: RE.listIsTask.test(d), loose: false, kids: [] });
  }
  const lastItem = node.items[node.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.txt = lastItem.txt.trimEnd();
  node.raw = s.slice(startPos, cur).trimEnd();
  for (const item of node.items) {
    ctx.top = false;
    item.kids = [];
    lexBlocks(item.txt, links, ctx, false, item.kids);
    if (!node.loose) {
      const spaces = item.kids.filter((k) => k.k === "space");
      if (spaces.length > 0 && spaces.some((g) => RE.anyLine.test(g.raw))) node.loose = true;
    }
  }
  for (const item of node.items) {
    const first = item.kids[0];
    if (item.task && first && (first.k === "text" || first.k === "para")) {
      item.txt = item.txt.replace(RE.listReplaceTask, "");
      first.txt = first.txt.replace(RE.listReplaceTask, "");
      const ck = RE.listTaskCheckbox.exec(item.raw);
      if (ck) {
        const checked = ck[0] !== "[ ]";
        item.checked = checked;
        if (node.loose) {
          first.box = checked;
        } else {
          item.kids.unshift({ k: "box", checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (node.loose) {
    for (const item of node.items) {
      item.loose = true;
      for (const kid of item.kids) if (kid.k === "text") kid.k = "para";
    }
  }
  return [node, node.raw.length];
}

// ---- rendering -----------------------------------------------------------
// Rendering walks the block nodes and runs inline parsing now, with the
// complete link-definition map (inline parsing is deferred past lexing).

function inlineTop(src, links, st) {
  st.inRawBlock = false;
  return inlineRun(src, links, st, 0);
}

function checkboxHtml(checked) {
  return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
}

function renderCode(node) {
  const first = (node.lang || "").match(RE.notSpaceStart)?.[0] || "";
  const body = node.txt ? node.txt.replace(RE.endingNewline, "") + "\n" : "";
  const esc = escHtml(body, true);
  return first
    ? '<pre><code class="language-' + escHtml(first) + '">' + esc + "</code></pre>\n"
    : "<pre><code>" + esc + "</code></pre>\n";
}

function renderCell(cell, isHead, links, st) {
  const tag = isHead ? "th" : "td";
  const open = cell.al ? "<" + tag + ' align="' + cell.al + '">' : "<" + tag + ">";
  return open + inlineTop(cell.txt, links, st) + "</" + tag + ">\n";
}

function renderTable(node, links, st) {
  let head = "";
  for (const c of node.head) head += renderCell(c, true, links, st);
  let body = "";
  for (const row of node.rows) {
    let r = "";
    for (const c of row) r += renderCell(c, false, links, st);
    body += "<tr>\n" + r + "</tr>\n";
  }
  return (
    "<table>\n<thead>\n<tr>\n" +
    head +
    "</tr>\n</thead>\n" +
    (body ? "<tbody>" + body + "</tbody>" : "") +
    "</table>\n"
  );
}

function renderList(node, links, st) {
  let items = "";
  for (const item of node.items) {
    items += "<li>" + renderBlocks(item.kids, links, st) + "</li>\n";
  }
  const tag = node.ord ? "ol" : "ul";
  const start = node.ord && node.start !== 1 ? ' start="' + node.start + '"' : "";
  return "<" + tag + start + ">\n" + items + "</" + tag + ">\n";
}

function renderBlocks(nodes, links, st) {
  let out = "";
  for (const node of nodes) {
    switch (node.k) {
      case "space":
      case "def":
        break;
      case "code":
        out += renderCode(node);
        break;
      case "head":
        out += "<h" + node.d + ">" + inlineTop(node.txt, links, st) + "</h" + node.d + ">\n";
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "quote":
        out += "<blockquote>\n" + renderBlocks(node.kids, links, st) + "</blockquote>\n";
        break;
      case "list":
        out += renderList(node, links, st);
        break;
      case "box":
        out += checkboxHtml(node.checked);
        break;
      case "html":
        out += node.txt;
        break;
      case "table":
        out += renderTable(node, links, st);
        break;
      case "para": {
        const inner = inlineTop(node.txt, links, st);
        out += "<p>" + (node.box !== undefined ? checkboxHtml(node.box) : "") + inner + "</p>\n";
        break;
      }
      case "text": {
        const inner = inlineTop(node.txt, links, st);
        out += (node.box !== undefined ? checkboxHtml(node.box) : "") + inner;
        break;
      }
    }
  }
  return out;
}

// Render `markdown` to exactly the HTML marked 18.1.3 renders with its
// default options. Stateless across calls: nothing is kept from an
// earlier call.
export function parse(markdown) {
  if (typeof markdown !== "string") {
    throw new Error(
      "marked(): input parameter is of type " +
        Object.prototype.toString.call(markdown) +
        ", string expected",
    );
  }
  const src = markdown.indexOf("\r") === -1 ? markdown : markdown.replace(/\r\n|\r/g, "\n");
  const links = Object.create(null);
  const ctx = { top: true };
  const st = newInlineState();
  const nodes = [];
  lexBlocks(src, links, ctx, false, nodes);
  return renderBlocks(nodes, links, st);
}
