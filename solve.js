// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Original implementation, written from the makefun-site README (the dialect spec)
// with the vendor code as the reference for the exact answers. Same pipeline, same
// outputs, byte for byte; faster by doing less work per character:
//
// - Markdown is rendered in one pass over the source lines, straight into an output
//   array: no block-token objects, no per-line regex where a first-character test
//   decides, and inline text is escaped in bulk instead of one character at a time.
// - Front matter and Markdown share the one split of the source into lines, and the
//   body is never re-joined into a string.
// - Templates are parsed once per case, includes are flattened into the tree (the
//   include depth is fixed at flatten time), adjacent text nodes are merged, and
//   rendering walks one flat list into a shared output array.
// - Slugs and long dates are memoised per build; repeated tag names and dates are
//   common, and a slug's normalisation is the dearest single string operation.
// - Nothing is cached from one run() call to the next: every cache is made fresh
//   inside run(), so each case is answered alone.
//
// Node 22, standard library only, no network, no clock, no randomness: the output
// is a function of the input alone.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC_MAP[c]) : text;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** JavaScript whitespace, by UTF-16 code unit (the \s set). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** The words of one line: its runs of characters other than whitespace. */
function wordsOfLine(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    if (WS_TABLE[line.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most SLUG_MAX
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Pure ASCII text takes a regex fast path; anything else follows the same rule
 * character by character.
 */
function slugify(text) {
  if (!/[^\x00-\x7f]/.test(text)) {
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter
//
// A source opens on a line "---" and its front matter runs to the next line "---";
// every line between is blank, a comment ("#" first) or "key: value" with one space
// after the colon. Seven keys are known, each with its own value grammar, and
// anything else refuses the file with the first reason met, line by line.

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `raw` with its trailing spaces and tabs dropped. */
function trimEndSpaces(raw) {
  let end = raw.length;
  while (end > 0) {
    const c = raw.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === raw.length ? raw : raw.slice(0, end);
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let y = 0;
      let mo = 0;
      let d = 0;
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (!/^[a-z0-9-]+$/.test(raw)) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, bodyStart } with bodyStart the index in `lines`
 * of the first body line, or { error } with the first reason it is refused.
 * `lines` is the source's text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // A "key: value" line: a key of a-z and _, a colon, one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    let raw = null;
    if (k > 0 && line.charCodeAt(k) === 58) {
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    }
    if (raw === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    raw = trimEndSpaces(raw);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown
//
// The dialect's own subset, rendered in one pass over the source lines, straight
// into an output array: no block-token objects, no per-line regex where a first
// character decides. Inline text is scanned for the next special character and
// the plain runs between them are escaped in bulk.

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SPECIAL_RE = /[\\`*[]/g;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A line with its leading and trailing spaces and tabs dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '' || isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96 && FENCE_OPEN.test(line)) return true;
  if (c === 35 && headingOf(line) !== null) return true;
  if ((c === 45 || c === 42) && HR.test(line)) return true;
  return false;
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * within [from, end), or -1. A match is escaped exactly when the run of backslashes
 * right before it is odd: the scanner consumes backslashes in pairs, left to right.
 */
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= end) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/**
 * The first single * from `from` (one whose run is not **), outside an escape,
 * within [from, end), or -1. A pair of stars is skipped as one, as the reference
 * scanner does when it steps over a `**` pair.
 */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline into `out`; `link(target)` is a link's href.
 * Plain runs are escaped in bulk; only the characters that open a span, strong,
 * emphasis or link are handled one by one. The shared SPECIAL_RE is safe across
 * the recursion: every exec is preceded by setting lastIndex in the same call.
 */
function inlineInto(s, a, b, link, out) {
  let i = a;
  for (;;) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const j = m !== null && m.index < b ? m.index : -1;
    if (j === -1) {
      if (i < b) out.push(esc(s.slice(i, b)));
      return;
    }
    if (j > i) out.push(esc(s.slice(i, j)));
    const c = s.charCodeAt(j);
    if (c === 92) {
      // A backslash before an escapable character writes that character (escaped).
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        const n = s[j + 1];
        out.push(n === '>' ? '&gt;' : n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (j + 1 < b && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, b);
        if (k !== -1 && k > j + 1) {
          out.push('<em>');
          inlineInto(s, j + 1, k, link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    // '[': the first ']' not escaped closes the text, '(' must follow at once, and
    // the next ')' closes the target, which must not be empty or hold whitespace.
    const k = findUnescaped(s, ']', j + 1, b);
    let target = null;
    let close = -1;
    if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
      close = s.indexOf(')', k + 2);
      if (close !== -1 && close < b) target = s.slice(k + 2, close);
    }
    if (target !== null && target !== '' && !/\s/.test(target)) {
      out.push('<a href="', esc(link(target)), '">');
      inlineInto(s, j + 1, k, link, out);
      out.push('</a>');
      i = close + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
}

/**
 * `lines[start..]` rendered: its HTML (each block on its own lines, a "\n" after
 * the last), its table of contents (every level 2 and 3 heading: level, id and its
 * inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `link(target)` resolves a link's href; `ids` is the page's set of heading ids;
 * `parts` is a scratch array, reset here and joined for the HTML.
 */
function renderMd(lines, start, link, ids, parts) {
  parts.length = 0;
  ids.clear();
  const toc = [];
  let excerpt = null;
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // A fence: three backticks and an optional language, body to a closing fence.
    if (c0 === 96 && line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        i++;
        parts.push('<pre><code', lang === '' ? '' : ` class="language-${esc(lang)}"`, '>');
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          parts.push(esc(lines[i]), '\n');
          i++;
        }
        i++;
        parts.push('</code></pre>', '\n');
        continue;
      }
    }
    // A heading: 1 to 6 '#', a space or tab, then text.
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const inner = [];
        inlineInto(h.text, 0, h.text.length, link, inner);
        const html = inner.join('');
        parts.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>`, '\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    // A thematic break: '---' or '***', then spaces or tabs only.
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      parts.push('<hr>', '\n');
      i++;
      continue;
    }
    // A blockquote: the lines opening on '>', each with the '>' and one space
    // after it dropped, then trimmed; the empty ones dropped.
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        const text = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(text, 0, text.length, link, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // A list: '- ', '* ' (a bullet list) or digits and '. ' (an ordered list).
    // A line of two or more spaces then a non-space continues the item.
    const isBullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    const isDigit = c0 >= 48 && c0 <= 57;
    if (isBullet || isDigit) {
      const bullet = isBullet ? BULLET.exec(line) : null;
      const ordered = bullet === null && isDigit ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const items = [];
        while (i < n) {
          const li = lines[i];
          const mm = isOrdered ? ORDERED.exec(li) : BULLET.exec(li);
          if (mm !== null) {
            items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
            i++;
          } else if (CONTINUED.test(li)) {
            items[items.length - 1].push(trimLine(li));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
        parts.push(open, '\n');
        for (const item of items) {
          const text = item.join('\n');
          parts.push('<li>');
          inlineInto(text, 0, text.length, link, parts);
          parts.push('</li>\n');
        }
        parts.push(`</${tag}>`, '\n');
        continue;
      }
    }
    // A paragraph: the lines up to a blank line, a fence, a heading or a break.
    // Only the first paragraph's HTML is needed as a string (the excerpt).
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) text += `\n${trimLine(lines[i++])}`;
    if (excerpt === null) {
      const inner = [];
      inlineInto(text, 0, text.length, link, inner);
      excerpt = inner.join('');
      parts.push('<p>', excerpt, '</p>', '\n');
    } else {
      parts.push('<p>');
      inlineInto(text, 0, text.length, link, parts);
      parts.push('</p>', '\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates
//
// The dialect's own: {{ path }} escaped, {{{ path }}} raw, {% for x in path %}
// with loop (index from 1, first, last, length), {% if path %} / {% if not path %}
// with an optional else, {% include "name" %} (missing, or nested more than 8
// deep, renders nothing). A {% %} tag alone on its line takes the whole line
// with it, its newline included.
//
// A template is parsed once into a tree of nodes, then includes are flattened
// into that tree (an include's depth is fixed when it is flattened, so the
// depth rule needs no check at render time), adjacent text nodes are merged,
// and rendering walks the flat list into a shared output array.

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Whether `s[a..b)` is spaces and tabs only. */
function isSpaces(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * `nodes` with every include expanded in place, at the depth it is rendered.
 * `depth` is the depth the list itself renders at; an include inside it renders
 * its template at depth + 1, and one at depth INCLUDE_DEPTH renders nothing.
 * Adjacent text nodes are merged. Node objects are shared, never mutated.
 */
function flatten(nodes, templates, depth, memo) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'include') {
      if (depth >= INCLUDE_DEPTH) continue;
      const t = templates.get(n.name);
      if (t === undefined) continue;
      const key = `${n.name}@${depth + 1}`;
      let flat = memo.get(key);
      if (flat === undefined) {
        flat = flatten(t, templates, depth + 1, memo);
        memo.set(key, flat);
      }
      for (const m of flat) out.push(m);
      continue;
    }
    if (n.kind === 'for') {
      out.push({ kind: 'for', name: n.name, path: n.path, body: flatten(n.body, templates, depth, memo) });
      continue;
    }
    if (n.kind === 'if') {
      out.push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: flatten(n.then, templates, depth, memo),
        else: n.else === null ? null : flatten(n.else, templates, depth, memo),
      });
      continue;
    }
    if (n.kind === 'text' && out.length > 0 && out[out.length - 1].kind === 'text') out[out.length - 1] = { kind: 'text', text: out[out.length - 1].text + n.text };
    else out.push(n);
  }
  return out;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out`, in the scope chain `scope`. */
function renderInto(nodes, scope, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderInto(n.body, { vars, parent: scope }, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build
//
// The plugins, in order: sources, front matter, permalinks, Markdown,
// collections, tags, layouts, report. Every cache is made fresh inside run(),
// so each case is answered alone.

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const slug = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugify(t);
      slugCache.set(t, s);
    }
    return s;
  };
  const long = (d) => {
    let s = dateCache.get(d);
    if (s === undefined) {
      s = longDate(d);
      dateCache.set(d, s);
    }
    return s;
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of their name; one that does not parse
  // is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // A template's flattened nodes (includes expanded, text merged), by name.
  const flatMemo = new Map();
  const flat = (name) => {
    let f = flatMemo.get(name);
    if (f === undefined) {
      const nodes = templates.get(name);
      if (nodes === undefined) return undefined;
      f = flatten(nodes, templates, 0, flatMemo);
      // Merge the text nodes that became adjacent across an include boundary.
      const merged = [];
      for (const n of f) {
        if (n.kind === 'text' && merged.length > 0 && merged[merged.length - 1].kind === 'text') {
          merged[merged.length - 1] = { kind: 'text', text: merged[merged.length - 1].text + n.text };
        } else merged.push(n);
      }
      f = merged;
      flatMemo.set(name, f);
    }
    return f;
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  // a source that is not .md is static. The split into lines is shared by the
  // front matter and the Markdown, and the body is never re-joined.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const mdParts = [];
  const mdIds = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMd(s.lines, s.bodyStart, link, mdIds, mdParts);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (seen.has(sl)) continue;
      seen.add(sl);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  /** A page's link record as templates read it. */
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : long(s.data.date) };

  /** A post's card, as lists show it. */
  const cardOf = (s) => {
    let words = 0;
    for (let i = s.bodyStart; i < s.lines.length; i++) words += wordsOfLine(s.lines[i]);
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : long(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };

  /** A page as its layout reads it. */
  const pageOf = (s, card) => ({
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const output = {};
  const renderOut = [];
  const topScope = { vars: null, parent: baseScope };
  const render = (name, extra) => {
    const nodes = flat(name);
    if (nodes === undefined) return null;
    renderOut.length = 0;
    topScope.vars = extra;
    renderInto(nodes, topScope, renderOut);
    return renderOut.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? cards.get(s) : cardOf(s)) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
