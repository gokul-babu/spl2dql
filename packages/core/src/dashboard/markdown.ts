/**
 * Splunk text that lands in a Dynatrace Markdown tile is data, not Markdown (ADR-029,
 * docs/spec/dashboards.md §4 "Text in Markdown tiles"). The output keeps four properties:
 * outside an indented code block it holds no `<` and no backtick (those, `& > [ ] ( )`, are written
 * as entities); no bare address is linkable (`\://`, `www\.`); there are no code spans; a tile is
 * cut at a line end (convert.ts).
 *
 * - `escapeText`: a title, a name, a reason, a description, a text node of an `<html>` panel.
 * - `codeBlock`: an indented code block, split on every line ending Unicode knows, without control
 *   characters, so no line can leave the block.
 * - `rebuildMarkdown`: Markdown that Splunk itself calls Markdown (a Studio `splunk.markdown`). It is
 *   never passed through: it is read into a small allow-list — headings, list items, paragraphs,
 *   blank lines; inside a line bold, italic and links — and written out again. Everything else is
 *   escaped text. A link is written only with a target that passes `isWebTarget`.
 *
 * Every function is linear in the length of its input.
 */

/** Line endings: CRLF, CR, LF, U+2028, U+2029 (and NEL, which is a control character anyway). */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/g;
/** Control characters other than tab and line feed. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * The only link target ever written (ADR-029): `http://` or `https://` followed by characters that
 * are none of whitespace, control characters, angle brackets, parentheses, square brackets, a
 * backslash, a backtick or a quote.
 */
export function isWebTarget(target: string): boolean {
  return /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f<>()[\]\\`"']+$/i.test(target);
}

/**
 * Plain text as one Markdown-safe line. Line breaks become spaces and control characters go. `_`
 * between two letters or digits, `#`, `!`, `&` and list markers are left alone where Markdown
 * cannot read them, so ordinary text stays readable in the tile's source.
 */
export function escapeText(text: string, max = Number.POSITIVE_INFINITY): string {
  return escapeInline(text.replace(LINE_BREAK, ' ').replace(CONTROL, '').trim(), true, max);
}

/**
 * Characters written as entities in text (ADR-029, third round). An entity can never start
 * Markdown or HTML syntax, and no renderer that links bare addresses can take it into an address
 * the way it takes the backslash of `\<`. The only raw `[ ] ( )` are those of a link the converter
 * writes; no `<` and no backtick appear outside an indented code block at all.
 */
const ENTITY: Readonly<Record<string, string>> = Object.fromEntries([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['`', '&#96;'],
  ['[', '&#91;'],
  [']', '&#93;'],
  ['(', '&#40;'],
  [')', '&#41;'],
]);

/** Escaped with a backslash wherever they stand. */
const BACKSLASHED = new Set(['\\', '*', '|', '~']);

/**
 * Escapes one piece of a line; `lineStart`: the piece begins the line (block markers matter).
 * Stops before the result would be longer than `max` and ends it with "…": text is cut before it
 * is written, never inside an entity or an escape.
 */
function escapeInline(flat: string, lineStart: boolean, max = Number.POSITIVE_INFINITY): string {
  // Start of a closing run of "#" (an ATX heading would drop it).
  let tail = flat.length;
  while (tail > 0 && flat[tail - 1] === '#') tail--;
  let out = '';
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i] as string;
    const prev = flat[i - 1] ?? '';
    const next = flat[i + 1] ?? '';
    const entity = Object.hasOwn(ENTITY, c) ? ENTITY[c] : undefined;
    let needs = BACKSLASHED.has(c);
    if (c === '_') needs = !(isWordChar(prev) && isWordChar(next));
    // "!" right before a link the converter writes would make it an image.
    else if (c === '!') needs = next === '';
    else if (c === '#') needs = i === 0 || i >= tail;
    // No bare address is linkable: "://" is written "\://", "www." as "www\." (any case).
    else if (c === ':') needs = next === '/' && flat[i + 2] === '/';
    else if (c === '.') needs = (i >= 3 && flat.slice(i - 3, i).toLowerCase() === 'www') || (lineStart && i > 0 && i <= 9 && /^\d+$/.test(flat.slice(0, i)));
    // Block markers at the start of a line: lists, setext underlines, thematic breaks.
    else if (lineStart && i === 0 && (c === '-' || c === '+' || c === '=')) needs = true;
    const piece = entity ?? (needs ? `\\${c}` : c);
    if (out.length + piece.length > max - 1) return `${out}…`;
    out += piece;
  }
  return out;
}

/**
 * The last step for a line assembled from several escaped pieces (ADR-029, third round). Each piece
 * is safe by itself, but two pieces can meet and spell what one piece never contains: an address
 * (`https:` then `//…`, `www` then `.…`), an ordered-list marker (`1` then `. …`), or leading
 * blanks that would make an indented code block. Outside the target of a link the converter wrote
 * (the only place a raw `](` occurs), `://` becomes `\://`, `www.` becomes `www\.` and a `//` that
 * starts an address becomes `\/\/`. Linear; sealing a sealed line changes nothing.
 */
export function sealLine(line: string): string {
  const s = line.trim();
  // Written pieces are collected and joined once; the end of what was written is tracked beside
  // them, so nothing ever reads back a string that is still growing.
  const out: string[] = [];
  let tail = ''; // the last three characters written
  let slashes = 0; // backslashes at the end: an odd count means the next character is escaped
  let onlyDigits = true; // everything written so far is a digit
  const put = (text: string): void => {
    out.push(text);
    tail = (tail + text).slice(-3);
    for (let k = 0; k < text.length; k++) {
      const ch = text[k] as string;
      slashes = ch === '\\' ? slashes + 1 : 0;
      if (ch < '0' || ch > '9') onlyDigits = false;
    }
  };
  let inTarget = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inTarget) {
      put(c);
      if (c === ')') inTarget = false;
      continue;
    }
    if (c === ']' && s[i + 1] === '(') {
      put('](');
      i++;
      inTarget = true;
      continue;
    }
    if (slashes % 2 === 0) {
      const last = tail[tail.length - 1];
      if (c === ':' && s[i + 1] === '/' && s[i + 2] === '/') {
        put('\\:');
        continue;
      }
      if (c === '.' && tail.toLowerCase() === 'www') {
        put('\\.');
        continue;
      }
      if (c === '/' && s[i + 1] === '/' && last !== ':' && last !== '/') {
        put('\\/\\/');
        i++;
        continue;
      }
      if (c === '.' && i > 0 && i <= 9 && onlyDigits && (i + 1 === s.length || /\s/.test(s[i + 1] as string))) {
        put('\\.');
        continue;
      }
    }
    put(c);
  }
  return out.join('');
}

function isWordChar(c: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(c);
}

/** An indented code block: unlike a fenced one it cannot be closed by backticks in the text. */
export function codeBlock(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((l) => `    ${l.replace(CONTROL, '')}`)
    .join('\n');
}

// ---------------------------------------------------------------------------------------------------
// Rebuilding Splunk's Markdown

/** Markdown written for Splunk, read into the allow-list and written out again. */
export function rebuildMarkdown(markdown: string): string {
  const lines = markdown.replace(LINE_BREAK, '\n').replace(CONTROL, '').split('\n');
  const out: string[] = [];
  const blank = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  };
  let fence: { char: string; length: number } | undefined;
  for (const raw of lines) {
    if (fence) {
      // A fenced code block becomes escaped text lines.
      if (closesFence(raw, fence)) {
        fence = undefined;
        blank();
        continue;
      }
      const text = escapeText(raw);
      if (text !== '') out.push(text);
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (open) {
      const run = open[1] as string;
      fence = { char: run[0] as string, length: run.length };
      blank();
      continue;
    }
    const line = raw.trim();
    if (line === '') {
      blank();
      continue;
    }
    const heading = readHeading(line);
    if (heading) {
      const text = sealLine(inline(heading.text, false, true));
      if (text !== '') out.push(`${'#'.repeat(heading.level)} ${text}`);
      continue;
    }
    const item = readListItem(line);
    if (item) {
      // A list item's content is a block of its own: it starts a line.
      const text = sealLine(inline(item.text, true, true));
      if (text !== '') out.push(`${item.marker} ${text}`);
      continue;
    }
    const text = sealLine(inline(line, true, true));
    if (text !== '') out.push(text);
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function closesFence(line: string, fence: { char: string; length: number }): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && (m[1] as string)[0] === fence.char && (m[1] as string).length >= fence.length;
}

/** `# text`, up to six `#`, with an optional closing run of `#` after a blank. */
function readHeading(line: string): { level: number; text: string } | undefined {
  let level = 0;
  while (level < line.length && line[level] === '#') level++;
  if (level === 0 || level > 6) return undefined;
  const after = line[level];
  if (after !== undefined && after !== ' ' && after !== '\t') return undefined;
  let text = line.slice(level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t') text = text.slice(0, end).trim();
  return { level, text };
}

/** `- item`, `* item`, `+ item`, `1. item`, `1) item` (written as `1.`). */
function readListItem(line: string): { marker: string; text: string } | undefined {
  const c = line[0];
  if ((c === '-' || c === '*' || c === '+') && (line[1] === ' ' || line[1] === '\t')) return { marker: '-', text: line.slice(2).trim() };
  let i = 0;
  while (i < line.length && i < 10 && line[i] !== undefined && /[0-9]/.test(line[i] as string)) i++;
  if (i === 0 || i > 9) return undefined;
  if ((line[i] === '.' || line[i] === ')') && (line[i + 1] === ' ' || line[i + 1] === '\t')) {
    return { marker: `${line.slice(0, i)}.`, text: line.slice(i + 2).trim() };
  }
  return undefined;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

interface Atom {
  c: string;
  /** Written with a backslash in the input: never a delimiter. */
  literal: boolean;
}

/**
 * One line's inline content, rebuilt. Code spans, links and images are recognised first; the text
 * between them is read for bold and italic; everything else is escaped text. `links`: false inside
 * the text of a link (a link cannot hold another).
 */
function inline(src: string, lineStart: boolean, links: boolean): string {
  const n = src.length;
  // A backslash before ASCII punctuation makes it a plain character, as in CommonMark.
  const escaped = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) {
    if (src[i] === '\\' && ASCII_PUNCTUATION.test(src[i + 1] as string)) {
      escaped[i] = 1;
      i++;
    }
  }
  const closeBracket = new Map<number, number>();
  const closeParen = new Map<number, number>();
  if (links) {
    const brackets: number[] = [];
    const parens: number[] = [];
    for (let i = 0; i < n; i++) {
      if (escaped[i]) {
        i++;
        continue;
      }
      const c = src[i];
      if (c === '[') brackets.push(i);
      else if (c === ']' && brackets.length > 0) closeBracket.set(brackets.pop() as number, i);
      else if (c === '(') parens.push(i);
      else if (c === ')' && parens.length > 0) closeParen.set(parens.pop() as number, i);
    }
  }
  let out = '';
  let atoms: Atom[] = [];
  const flush = (): void => {
    if (atoms.length === 0) return;
    out += emphasis(atoms, lineStart && out === '');
    atoms = [];
  };
  for (let i = 0; i < n; ) {
    if (escaped[i]) {
      atoms.push({ c: src[i + 1] as string, literal: true });
      i += 2;
      continue;
    }
    // A backtick is plain text: there are no code spans (ADR-029, third round).
    const c = src[i] as string;
    const bracket = c === '!' && src[i + 1] === '[' ? i + 1 : c === '[' ? i : -1;
    if (links && bracket !== -1) {
      const close = closeBracket.get(bracket);
      const paren = close === undefined ? undefined : closeParen.get(close + 1);
      if (close !== undefined && paren !== undefined) {
        flush();
        const target = src.slice(close + 2, paren).trim();
        // The label is text like any other: at the start of the line it is escaped as such.
        const label = inline(src.slice(bracket + 1, close), lineStart && out === '', false);
        // An image becomes a link (or its alt text): opening a dashboard never fetches anything.
        if (isWebTarget(target)) out += `[${label === '' ? escapeInline(target, false) : label}](${target})`;
        else out += label;
        i = paren + 1;
        continue;
      }
    }
    atoms.push({ c, literal: false });
    i++;
  }
  flush();
  return out;
}

/**
 * Bold (`**x**`, `__x__`) and italic (`*x*`, `_x_`) in a run of text, written as `**x**` and `*x*`
 * with escaped text inside. A closer is valid on its own (no blank before it; for `_`, no letter
 * after it), so the next valid closer of each kind is found from the right once: linear.
 */
function emphasis(atoms: readonly Atom[], lineStart: boolean): string {
  let out = '';
  let plain = '';
  const flush = (): void => {
    if (plain === '') return;
    out += escapeInline(plain, lineStart && out === '');
    plain = '';
  };
  const n = atoms.length;
  const delim = (k: number, c: string): boolean => atoms[k]?.c === c && atoms[k]?.literal === false;
  const space = (k: number): boolean => {
    const a = atoms[k];
    return a === undefined || /\s/.test(a.c);
  };
  const word = (k: number): boolean => {
    const a = atoms[k];
    return a !== undefined && isWordChar(a.c);
  };
  const nextBold = { '*': new Int32Array(n + 2).fill(-1), _: new Int32Array(n + 2).fill(-1) };
  const nextItalic = { '*': new Int32Array(n + 2).fill(-1), _: new Int32Array(n + 2).fill(-1) };
  for (const c of ['*', '_'] as const) {
    for (let k = n - 1; k >= 0; k--) {
      const bold = delim(k, c) && delim(k + 1, c) && !space(k - 1) && (c === '*' || !word(k + 2));
      const italic = delim(k, c) && !space(k - 1) && (c === '*' || !word(k + 1));
      nextBold[c][k] = bold ? k : (nextBold[c][k + 1] as number);
      nextItalic[c][k] = italic ? k : (nextItalic[c][k + 1] as number);
    }
  }
  const text = (from: number, to: number): string => {
    let s = '';
    for (let k = from; k < to; k++) s += (atoms[k] as Atom).c;
    return s;
  };
  for (let i = 0; i < n; ) {
    const a = atoms[i] as Atom;
    const c = a.c;
    if (!a.literal && (c === '*' || c === '_')) {
      if (delim(i + 1, c) && !space(i + 2) && (c === '*' || !word(i - 1))) {
        const j = nextBold[c][i + 3] ?? -1;
        if (j !== -1) {
          flush();
          out += `**${escapeInline(text(i + 2, j), false)}**`;
          i = j + 2;
          continue;
        }
      }
      if (!space(i + 1) && !delim(i + 1, c) && (c === '*' || !word(i - 1))) {
        const j = nextItalic[c][i + 2] ?? -1;
        if (j !== -1) {
          flush();
          out += `*${escapeInline(text(i + 1, j), false)}*`;
          i = j + 1;
          continue;
        }
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}
