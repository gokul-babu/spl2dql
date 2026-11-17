import type { Span } from '../types.ts';

export type DqlTokenType = 'ident' | 'backtick' | 'string' | 'number' | 'duration' | 'align' | 'punct' | 'comment' | 'error' | 'eof';

export interface DqlToken {
  type: DqlTokenType;
  text: string;
  span: Span;
}

const DURATION_UNITS = ['ns', 'us', 'ms', 's', 'm', 'h', 'd', 'w', 'M', 'q', 'y'];
const TWO_CHAR = new Set(['==', '!=', '<=', '>=']);
const ONE_CHAR = new Set(['|', ',', ':', '(', ')', '{', '}', '[', ']', '=', '<', '>', '+', '-', '*', '/', '%', '.']);

/**
 * Tokenises DQL text in one linear pass. Never throws; unknown characters become "error" tokens.
 * Comments are kept so the highlighter can use the same tokens; the parser skips them.
 */
export function tokenizeDql(text: string): DqlToken[] {
  const tokens: DqlToken[] = [];
  const n = text.length;
  let i = 0;
  const push = (type: DqlTokenType, start: number, end: number): void => {
    tokens.push({ type, text: text.slice(start, end), span: { start, end } });
  };
  while (i < n) {
    const ch = text.charCodeAt(i);
    const c = text[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const start = i;
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const close = text.indexOf('"""', i + 3);
        i = close === -1 ? n : close + 3;
        push(close === -1 ? 'error' : 'string', start, i);
        continue;
      }
      i = scanQuoted(text, i, '"');
      push(i < 0 ? 'error' : 'string', start, i < 0 ? n : i);
      if (i < 0) i = n;
      continue;
    }
    if (c === "'") {
      i = scanQuoted(text, i, "'");
      push(i < 0 ? 'error' : 'string', start, i < 0 ? n : i);
      if (i < 0) i = n;
      continue;
    }
    if (c === '`') {
      i = scanQuoted(text, i, '`');
      push(i < 0 ? 'error' : 'backtick', start, i < 0 ? n : i);
      if (i < 0) i = n;
      continue;
    }
    if (ch >= 48 && ch <= 57) {
      while (i < n && isDigit(text.charCodeAt(i))) i++;
      if (text[i] === '.' && isDigit(text.charCodeAt(i + 1))) {
        i++;
        while (i < n && isDigit(text.charCodeAt(i))) i++;
      }
      if ((text[i] === 'e' || text[i] === 'E') && /[0-9+-]/.test(text[i + 1] ?? '')) {
        const save = i;
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        if (isDigit(text.charCodeAt(i))) while (i < n && isDigit(text.charCodeAt(i))) i++;
        else i = save;
      }
      const unit = DURATION_UNITS.find((u) => text.startsWith(u, i) && !isIdentPart(text.charCodeAt(i + u.length)));
      if (unit) {
        i += unit.length;
        push('duration', start, i);
      } else {
        push('number', start, i);
      }
      continue;
    }
    if (c === '@') {
      i++;
      while (i < n && isIdentPart(text.charCodeAt(i))) i++;
      push(i - start > 1 ? 'align' : 'error', start, i);
      continue;
    }
    if (c === '$' && isIdentStart(text.charCodeAt(i + 1))) {
      // A dashboard variable stands for a value: a string by default, a number or a field with a modifier.
      i++;
      while (i < n && /[A-Za-z0-9_]/.test(text[i] as string)) i++;
      const mod = /^:(noquote|backtick|triplequote)(?![A-Za-z0-9_])/.exec(text.slice(i, i + 13));
      if (mod) i += mod[0].length;
      push(mod?.[1] === 'noquote' ? 'number' : mod?.[1] === 'backtick' ? 'backtick' : 'string', start, i);
      continue;
    }
    if (isIdentStart(ch)) {
      while (i < n && isIdentPart(text.charCodeAt(i))) i++;
      push('ident', start, i);
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      i += 2;
      push('punct', start, i);
      continue;
    }
    if (ONE_CHAR.has(c)) {
      i++;
      push('punct', start, i);
      continue;
    }
    // Consume one full code point so surrogate pairs stay together.
    i += ch >= 0xd800 && ch <= 0xdbff && i + 1 < n ? 2 : 1;
    push('error', start, i);
  }
  tokens.push({ type: 'eof', text: '', span: { start: n, end: n } });
  return tokens;
}

/** Returns the index just past the closing quote, or -1 if unterminated. */
function scanQuoted(text: string, start: number, q: string): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === q) return i + 1;
  }
  return -1;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c);
}
