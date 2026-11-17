import type { Span } from '../types.ts';
import { append } from '../util/array.ts';
import { findClosing, unescapeSpl } from './scanner.ts';
import { findQuoteEnd } from './split.ts';

/** SPL search-expression tree (the `search` command and the implicit leading search). */
export type SNode =
  | { t: 'term'; v: string; quoted: boolean; span: Span }
  | { t: 'cmp'; field: string; op: CmpOp; value: string; quoted: boolean; span: Span; fieldSpan: Span }
  | { t: 'in'; field: string; values: { v: string; quoted: boolean }[]; span: Span }
  | { t: 'func'; fn: 'CASE' | 'TERM'; v: string; span: Span }
  | { t: 'not'; e: SNode; span: Span }
  | { t: 'and'; items: SNode[]; span: Span }
  | { t: 'or'; items: SNode[]; span: Span }
  | { t: 'sub'; inner: Span; span: Span }
  /** An unresolved macro call left in place by expansion; it is dropped from the expression. */
  | { t: 'macro'; span: Span };

export type CmpOp = '=' | '!=' | '<' | '<=' | '>' | '>=';

export class SearchError extends Error {
  readonly span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.span = span;
  }
}

type Tok =
  | { type: 'word'; text: string; quoted: boolean; span: Span }
  | { type: '(' | ')' | 'eof'; span: Span }
  | { type: 'sub'; inner: Span; span: Span }
  | { type: 'macro'; span: Span };

const MAX_DEPTH = 200;
const MAX_TOKENS = 20_000;
const FIELD = /^[A-Za-z_][A-Za-z0-9_.:{}@-]*$/;

/**
 * Parses a search expression. Splunk precedence in search: NOT, then OR, then AND (implicit or
 * explicit) — so `A B OR C` means `A AND (B OR C)`. Returns undefined for an empty expression.
 */
export function parseSearch(text: string, start: number, end: number): SNode | undefined {
  const toks = tokenize(text, start, end);
  const p = new SearchParser(toks);
  if (p.atEnd()) return undefined;
  const node = p.andExpr();
  p.expectEnd();
  return node;
}

function tokenize(text: string, start: number, end: number): Tok[] {
  const toks: Tok[] = [];
  let i = start;
  while (i < end) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '`' && text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      i = close === -1 || close + 3 > end ? end : close + 3;
      continue;
    }
    if (c === '(' || c === ')') {
      toks.push({ type: c, span: { start: i, end: i + 1 } });
      i++;
      continue;
    }
    if (c === '[') {
      const close = findClosing(text, i, end, '[', ']');
      if (close === -1) throw new SearchError('A subsearch "[" is not closed.', { start: i, end });
      toks.push({ type: 'sub', inner: { start: i + 1, end: close }, span: { start: i, end: close + 1 } });
      i = close + 1;
      continue;
    }
    if (c === ']') throw new SearchError('Unexpected "]".', { start: i, end: i + 1 });
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      const stop = close === -1 || close >= end ? end : close + 1;
      toks.push({ type: 'macro', span: { start: i, end: stop } });
      i = stop;
      continue;
    }
    if (c === '"') {
      const q = findQuoteEnd(text, i, end);
      if (q === -1) throw new SearchError('A quoted string is not closed.', { start: i, end });
      toks.push({ type: 'word', text: unescapeSpl(text.slice(i + 1, q)), quoted: true, span: { start: i, end: q + 1 } });
      i = q + 1;
      continue;
    }
    // A bare word ends at whitespace or ( ) [ ] — but a quoted value may follow an operator: f="x y".
    const s = i;
    while (i < end) {
      const ch = text[i] as string;
      if (/[\s()[\]]/.test(ch)) break;
      if (ch === '"') {
        const q = findQuoteEnd(text, i, end);
        if (q === -1) throw new SearchError('A quoted string is not closed.', { start: i, end });
        i = q + 1;
        continue;
      }
      i++;
    }
    if (i === s) throw new SearchError(`Unexpected "${c}".`, { start: i, end: i + 1 });
    toks.push({ type: 'word', text: text.slice(s, i), quoted: false, span: { start: s, end: i } });
  }
  toks.push({ type: 'eof', span: { start: end, end } });
  if (toks.length > MAX_TOKENS) throw new SearchError(`The search has more than ${MAX_TOKENS} terms.`, { start, end });
  return toks;
}

/** Splits one unquoted IN-list token such as `a,"b c",d` on commas outside quotes. */
function splitInValues(text: string): { v: string; quoted: boolean }[] {
  const out: { v: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === '"') {
      const q = findQuoteEnd(text, i, text.length);
      const close = q === -1 ? text.length : q;
      out.push({ v: unescapeSpl(text.slice(i + 1, close)), quoted: true });
      i = close + 1;
      continue;
    }
    const next = text.indexOf(',', i);
    const stop = next === -1 ? text.length : next;
    const part = text.slice(i, stop).trim();
    if (part !== '') out.push({ v: part, quoted: false });
    i = stop;
  }
  return out;
}

class SearchParser {
  private i = 0;
  private depth = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private get t(): Tok {
    return this.toks[this.i] ?? (this.toks[this.toks.length - 1] as Tok);
  }
  /** Current token type, read through a call so TypeScript does not keep a stale narrowing. */
  private ty(): Tok['type'] {
    return this.t.type;
  }
  private peekTok(n: number): Tok {
    return this.toks[this.i + n] ?? (this.toks[this.toks.length - 1] as Tok);
  }
  private isKw(w: 'AND' | 'OR' | 'NOT'): boolean {
    const t = this.t;
    return t.type === 'word' && !t.quoted && t.text === w;
  }
  atEnd(): boolean {
    return this.t.type === 'eof';
  }
  expectEnd(): void {
    if (this.t.type === ')') throw new SearchError('Unexpected ")".', this.t.span);
    if (this.t.type !== 'eof') throw new SearchError('Unexpected text in the search.', this.t.span);
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new SearchError('The search is nested too deeply.', this.t.span);
  }

  andExpr(): SNode {
    this.enter();
    const items: SNode[] = [this.orExpr()];
    for (;;) {
      if (this.isKw('AND')) {
        this.i++;
        items.push(this.orExpr());
        continue;
      }
      if (this.t.type === 'eof' || this.t.type === ')') break;
      items.push(this.orExpr());
    }
    this.depth--;
    if (items.length === 1) return items[0] as SNode;
    return { t: 'and', items, span: spanOf(items) };
  }

  private orExpr(): SNode {
    const items: SNode[] = [this.notExpr()];
    while (this.isKw('OR')) {
      this.i++;
      items.push(this.notExpr());
    }
    if (items.length === 1) return items[0] as SNode;
    return { t: 'or', items, span: spanOf(items) };
  }

  private notExpr(): SNode {
    if (this.isKw('NOT')) {
      const s = this.t.span.start;
      this.i++;
      this.enter();
      const e = this.notExpr();
      this.depth--;
      return { t: 'not', e, span: { start: s, end: e.span.end } };
    }
    return this.primary();
  }

  private primary(): SNode {
    const t = this.t;
    if (t.type === '(') {
      this.i++;
      if (this.t.type === ')') throw new SearchError('Empty parentheses.', this.t.span);
      const e = this.andExpr();
      if (this.ty() !== ')') throw new SearchError('Expected ")".', this.t.span);
      this.i++;
      return e;
    }
    if (t.type === 'sub') {
      this.i++;
      return { t: 'sub', inner: t.inner, span: t.span };
    }
    if (t.type === 'macro') {
      this.i++;
      return { t: 'macro', span: t.span };
    }
    if (t.type !== 'word') throw new SearchError('Expected a search term.', t.span);
    this.i++;
    if (t.quoted) return { t: 'term', v: t.text, quoted: true, span: t.span };
    if (t.text === 'AND' || t.text === 'OR') throw new SearchError(`"${t.text}" needs a term on both sides.`, t.span);

    // CASE(x) / TERM(x): the word ends at "(" so the argument follows as ( word ).
    if ((t.text === 'CASE' || t.text === 'TERM') && this.t.type === '(') {
      const arg = this.peekTok(1);
      const close = this.peekTok(2);
      if (arg.type === 'word' && close.type === ')') {
        this.i += 3;
        return { t: 'func', fn: t.text, v: arg.text, span: { start: t.span.start, end: close.span.end } };
      }
    }

    // field IN (a, b, "c")
    if (FIELD.test(t.text) && this.t.type === 'word' && !this.t.quoted && this.t.text.toUpperCase() === 'IN' && this.peekTok(1).type === '(') {
      this.i += 2;
      const values: { v: string; quoted: boolean }[] = [];
      for (;;) {
        const v = this.t;
        if (this.ty() === ')') break;
        if (v.type !== 'word') throw new SearchError('Expected a value in the IN list.', v.span);
        this.i++;
        if (v.quoted) values.push({ v: v.text, quoted: true });
        else append(values, splitInValues(v.text));
      }
      const end = this.t.span.end;
      this.i++;
      return { t: 'in', field: t.text, values, span: { start: t.span.start, end } };
    }

    // field<op>value, possibly written with spaces: field = value
    const cmp = splitComparison(t.text);
    if (cmp) {
      let { value, quoted } = cmp;
      let end = t.span.end;
      if (value === '' && this.t.type === 'word') {
        const v = this.t;
        this.i++;
        value = v.text;
        quoted = v.quoted;
        end = v.span.end;
      }
      if (cmp.valueQuoted) {
        value = unescapeSpl(value.slice(1, -1));
        quoted = true;
      }
      return {
        t: 'cmp',
        field: cmp.field,
        op: cmp.op,
        value,
        quoted,
        span: { start: t.span.start, end },
        fieldSpan: { start: t.span.start, end: t.span.start + cmp.field.length },
      };
    }
    // field = value with spaces around the operator
    const next = this.t;
    if (FIELD.test(t.text) && next.type === 'word' && !next.quoted && /^(=|!=|<=|>=|<|>)/.test(next.text)) {
      const opMatch = /^(!=|<=|>=|=|<|>)/.exec(next.text);
      const op = (opMatch?.[1] ?? '=') as CmpOp;
      this.i++;
      let value = next.text.slice(op.length);
      let quoted = false;
      let end = next.span.end;
      if (value === '' && this.t.type === 'word') {
        const v = this.t;
        this.i++;
        value = v.text;
        quoted = v.quoted;
        end = v.span.end;
      } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = unescapeSpl(value.slice(1, -1));
        quoted = true;
      }
      return { t: 'cmp', field: t.text, op, value, quoted, span: { start: t.span.start, end }, fieldSpan: t.span };
    }
    return { t: 'term', v: t.text, quoted: false, span: t.span };
  }
}

function splitComparison(word: string): { field: string; op: CmpOp; value: string; quoted: boolean; valueQuoted: boolean } | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_.:{}@-]*)(!=|<=|>=|=|<|>)(.*)$/s.exec(word);
  if (!m) return undefined;
  const value = m[3] ?? '';
  const valueQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  return { field: m[1] as string, op: m[2] as CmpOp, value, quoted: false, valueQuoted };
}

function spanOf(items: SNode[]): Span {
  return { start: items[0]?.span.start ?? 0, end: items[items.length - 1]?.span.end ?? 0 };
}
