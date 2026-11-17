import type { Span } from '../types.ts';
import { findQuoteEnd } from './split.ts';

/**
 * A cursor over one region of the SPL text. Command modules read their arguments with it. Every
 * method is linear in the text it consumes; nothing backtracks more than one token.
 */
export class Scanner {
  readonly text: string;
  readonly end: number;
  pos: number;

  constructor(text: string, start: number, end: number) {
    this.text = text;
    this.pos = start;
    this.end = end;
  }

  skipWs(): void {
    while (this.pos < this.end) {
      const c = this.text[this.pos] as string;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++;
      } else if (c === '`' && this.text.startsWith('```', this.pos)) {
        const close = this.text.indexOf('```', this.pos + 3);
        this.pos = close === -1 || close + 3 > this.end ? this.end : close + 3;
      } else {
        return;
      }
    }
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.end;
  }

  peek(): string {
    this.skipWs();
    return this.pos < this.end ? (this.text[this.pos] as string) : '';
  }

  /** Consumes `ch` if it is next. */
  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.pos += ch.length;
      return true;
    }
    return false;
  }

  /** Consumes a case-insensitive keyword followed by a word boundary. */
  keyword(word: string): boolean {
    this.skipWs();
    const slice = this.text.slice(this.pos, this.pos + word.length);
    if (slice.toLowerCase() !== word.toLowerCase()) return false;
    const after = this.text[this.pos + word.length] ?? '';
    if (this.pos + word.length < this.end && /[A-Za-z0-9_]/.test(after)) return false;
    this.pos += word.length;
    return true;
  }

  peekKeyword(word: string): boolean {
    const save = this.pos;
    const ok = this.keyword(word);
    this.pos = save;
    return ok;
  }

  /** `name=value` option at the cursor, or undefined. Does not consume when absent. */
  option(): { name: string; value: string; quoted: boolean; span: Span; valueSpan: Span } | undefined {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.text.slice(this.pos, Math.min(this.end, this.pos + 80)));
    if (!m) return undefined;
    const start = this.pos;
    const name = m[0].replace(/\s*=$/, '');
    this.pos += m[0].length;
    this.skipWs();
    const value = this.value();
    if (!value) {
      this.pos = start;
      return undefined;
    }
    return { name, value: value.value, quoted: value.quoted, span: { start, end: value.span.end }, valueSpan: value.span };
  }

  /** A quoted string or a bare word. */
  value(): { value: string; quoted: boolean; span: Span } | undefined {
    this.skipWs();
    if (this.peek() === '"') {
      const q = this.quoted();
      return q ? { value: q.value, quoted: true, span: q.span } : undefined;
    }
    const w = this.word();
    return w ? { value: w.value, quoted: false, span: w.span } : undefined;
  }

  /** A run of characters up to whitespace, `,`, `(`, `)`, `[`, `]`, `"` or `|`. */
  word(extraStops = ''): { value: string; span: Span } | undefined {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.end) {
      const c = this.text[this.pos] as string;
      if (/[\s,()[\]"|]/.test(c) || extraStops.includes(c)) break;
      this.pos++;
    }
    if (this.pos === start) return undefined;
    return { value: this.text.slice(start, this.pos), span: { start, end: this.pos } };
  }

  /** A field name: bare (letters, digits, _ . * : { } @ -) or double-quoted. */
  fieldName(): { value: string; span: Span; quoted: boolean } | undefined {
    this.skipWs();
    if (this.peek() === '"') {
      const q = this.quoted();
      return q ? { value: q.value, span: q.span, quoted: true } : undefined;
    }
    if (this.peek() === "'") {
      const close = this.text.indexOf("'", this.pos + 1);
      if (close !== -1 && close < this.end) {
        const start = this.pos;
        this.pos = close + 1;
        return { value: this.text.slice(start + 1, close), span: { start, end: this.pos }, quoted: true };
      }
    }
    const start = this.pos;
    while (this.pos < this.end && /[A-Za-z0-9_.*:{}@\-/$]/.test(this.text[this.pos] as string)) this.pos++;
    if (this.pos === start) return undefined;
    // A default aggregate name such as avg(bytes) or p95(duration) is one field name in a field list.
    if (this.text[this.pos] === '(') {
      const close = findClosing(this.text, this.pos, this.end, '(', ')');
      if (close !== -1) {
        this.pos = close + 1;
        return { value: this.text.slice(start, this.pos).replace(/\s+/g, ''), span: { start, end: this.pos }, quoted: false };
      }
    }
    return { value: this.text.slice(start, this.pos), span: { start, end: this.pos }, quoted: false };
  }

  /** A double-quoted string with backslash escapes removed. */
  quoted(): { value: string; span: Span } | undefined {
    this.skipWs();
    if (this.text[this.pos] !== '"') return undefined;
    const close = findQuoteEnd(this.text, this.pos, this.end);
    if (close === -1) return undefined;
    const start = this.pos;
    this.pos = close + 1;
    return { value: unescapeSpl(this.text.slice(start + 1, close)), span: { start, end: this.pos } };
  }

  /** Text between a balanced pair starting at the cursor, e.g. `( … )` or `[ … ]`. */
  balanced(open: string, close: string): { inner: Span; span: Span } | undefined {
    this.skipWs();
    if (this.text[this.pos] !== open) return undefined;
    const start = this.pos;
    const endPos = findClosing(this.text, start, this.end, open, close);
    if (endPos === -1) return undefined;
    this.pos = endPos + 1;
    return { inner: { start: start + 1, end: endPos }, span: { start, end: this.pos } };
  }

  integer(): { value: number; span: Span } | undefined {
    this.skipWs();
    const m = /^\d{1,9}(?![A-Za-z0-9_.])/.exec(this.text.slice(this.pos, Math.min(this.end, this.pos + 12)));
    if (!m) return undefined;
    const start = this.pos;
    this.pos += m[0].length;
    return { value: Number(m[0]), span: { start, end: this.pos } };
  }

  rest(): Span {
    this.skipWs();
    const span = { start: this.pos, end: this.end };
    this.pos = this.end;
    return span;
  }

  here(): Span {
    this.skipWs();
    return { start: this.pos, end: Math.min(this.end, this.pos + 1) };
  }
}

/** Index of the matching `close` for the `open` at `start`, skipping quoted strings; -1 if none. */
export function findClosing(text: string, start: number, end: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === '"') {
      const q = findQuoteEnd(text, i, end);
      if (q === -1) return -1;
      i = q;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Position of the first top-level occurrence of any keyword (case-insensitive, whole word) in
 * [start, end), outside quotes and brackets; -1 if none.
 */
export function findKeyword(text: string, start: number, end: number, words: readonly string[]): { pos: number; word: string } | undefined {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = text[i] as string;
    if (c === '"') {
      const q = findQuoteEnd(text, i, end);
      if (q === -1) return undefined;
      i = q;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[A-Za-z]/.test(c) && (i === start || /[\s,)]/.test(text[i - 1] as string))) {
      for (const w of words) {
        if (text.slice(i, i + w.length).toLowerCase() === w && !/[A-Za-z0-9_]/.test(text[i + w.length] ?? '')) {
          return { pos: i, word: w };
        }
      }
    }
  }
  return undefined;
}

/** Removes SPL backslash escapes inside a double-quoted string: \" → ", \\ → \. */
export function unescapeSpl(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}
