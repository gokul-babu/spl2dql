import type { Span } from '../types.ts';
import { unescapeSpl } from './scanner.ts';
import { findQuoteEnd } from './split.ts';

/** SPL eval/where expression tree. */
export type SExpr =
  | { t: 'str'; v: string; span: Span }
  | { t: 'num'; v: string; span: Span }
  | { t: 'field'; name: string; span: Span }
  | { t: 'call'; fn: string; args: SExpr[]; span: Span; fnSpan: Span }
  | { t: 'un'; op: 'NOT' | '-'; e: SExpr; span: Span }
  | { t: 'bin'; op: SBinOp; l: SExpr; r: SExpr; span: Span }
  | { t: 'in'; e: SExpr; list: SExpr[]; span: Span };

export type SBinOp = 'OR' | 'XOR' | 'AND' | '=' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | '+' | '-' | '*' | '/' | '%' | '.';

export class ExprError extends Error {
  readonly span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.span = span;
  }
}

interface Tok {
  type: 'num' | 'str' | 'field' | 'ident' | 'op' | '(' | ')' | ',' | 'eof';
  text: string;
  span: Span;
}

const MAX_DEPTH = 200;
const MAX_TOKENS = 20_000;

/**
 * Parses an eval/where expression in [start, end). Precedence, loosest first:
 * XOR, OR, AND, NOT, comparison/LIKE/IN, + - ., * / %, unary minus.
 * Throws ExprError (caught by the caller and reported as SPL1004).
 */
export function parseExpr(text: string, start: number, end: number): SExpr {
  const p = new ExprParser(tokenize(text, start, end));
  const e = p.expr();
  p.expectEnd();
  return e;
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
    const s = i;
    if (c === '"') {
      const q = findQuoteEnd(text, i, end);
      if (q === -1) throw new ExprError('A quoted string is not closed.', { start: i, end });
      toks.push({ type: 'str', text: unescapeSpl(text.slice(i + 1, q)), span: { start: s, end: q + 1 } });
      i = q + 1;
      continue;
    }
    if (c === '$') {
      // A dashboard token standing for a value: where count > $threshold$
      const m = /^\$[A-Za-z_][A-Za-z0-9_.]*(?:\|[A-Za-z]+)?\$/.exec(text.slice(i, Math.min(end, i + 200)));
      if (m) {
        toks.push({ type: 'str', text: m[0], span: { start: s, end: i + m[0].length } });
        i += m[0].length;
        continue;
      }
    }
    if (c === "'") {
      const q = text.indexOf("'", i + 1);
      if (q === -1 || q >= end) throw new ExprError('A quoted field name is not closed.', { start: i, end });
      toks.push({ type: 'field', text: text.slice(i + 1, q), span: { start: s, end: q + 1 } });
      i = q + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i, Math.min(end, i + 64)));
      const len = m ? m[0].length : 1;
      // A number directly followed by letters is part of a name, e.g. 4xx.
      if (/[A-Za-z_]/.test(text[i + len] ?? '')) {
        i = readIdent(text, i, end, toks);
        continue;
      }
      toks.push({ type: 'num', text: text.slice(i, i + len), span: { start: s, end: i + len } });
      i += len;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      i = readIdent(text, i, end, toks);
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      toks.push({ type: 'op', text: two, span: { start: s, end: i + 2 } });
      i += 2;
      continue;
    }
    if ('=<>+-*/%.'.includes(c)) {
      toks.push({ type: 'op', text: c, span: { start: s, end: i + 1 } });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      toks.push({ type: c, text: c, span: { start: s, end: i + 1 } });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}".`, { start: i, end: i + 1 });
  }
  toks.push({ type: 'eof', text: '', span: { start: end, end } });
  if (toks.length > MAX_TOKENS) throw new ExprError(`The expression has more than ${MAX_TOKENS} parts.`, { start, end });
  return toks;
}

function readIdent(text: string, i: number, end: number, toks: Tok[]): number {
  const s = i;
  // Dots inside a name (no surrounding spaces) belong to the name: data.user, host.name.
  while (i < end && /[A-Za-z0-9_.{}@:]/.test(text[i] as string)) {
    if (text[i] === '.' && !/[A-Za-z0-9_{]/.test(text[i + 1] ?? '')) break;
    i++;
  }
  toks.push({ type: 'ident', text: text.slice(s, i), span: { start: s, end: i } });
  return i;
}

class ExprParser {
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
  private next(): Tok {
    return this.toks[this.i++] ?? (this.toks[this.toks.length - 1] as Tok);
  }
  private word(w: string): boolean {
    return this.t.type === 'ident' && this.t.text.toUpperCase() === w;
  }
  private op(o: string): boolean {
    return this.t.type === 'op' && this.t.text === o;
  }
  private fail(msg: string): never {
    const found = this.t.type === 'eof' ? 'the end' : `"${this.t.text}"`;
    throw new ExprError(`${msg}, found ${found}.`, this.t.span);
  }
  expectEnd(): void {
    if (this.t.type !== 'eof') this.fail('Unexpected text in expression');
  }
  private guard<T>(f: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new ExprError('The expression is nested too deeply.', this.t.span);
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  expr(): SExpr {
    return this.guard(() => this.left(['XOR'], () => this.left(['OR'], () => this.left(['AND'], () => this.notExpr()))));
  }

  private left(ops: string[], sub: () => SExpr): SExpr {
    let l = sub();
    while (ops.some((o) => this.word(o))) {
      const op = this.next().text.toUpperCase() as SBinOp;
      const r = sub();
      l = { t: 'bin', op, l, r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }

  private notExpr(): SExpr {
    if (this.word('NOT')) {
      const s = this.next().span.start;
      const e = this.guard(() => this.notExpr());
      return { t: 'un', op: 'NOT', e, span: { start: s, end: e.span.end } };
    }
    return this.comparison();
  }

  private comparison(): SExpr {
    const l = this.additive();
    const t = this.t;
    if (t.type === 'op' && ['=', '==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.next();
      const r = this.additive();
      return { t: 'bin', op: t.text as SBinOp, l, r, span: { start: l.span.start, end: r.span.end } };
    }
    if (this.word('LIKE')) {
      this.next();
      const r = this.additive();
      return { t: 'bin', op: 'LIKE', l, r, span: { start: l.span.start, end: r.span.end } };
    }
    if (this.word('IN')) {
      this.next();
      if (this.t.type !== '(') this.fail('Expected "(" after IN');
      this.next();
      const list: SExpr[] = [];
      if (this.ty() !== ')') {
        list.push(this.expr());
        while (this.ty() === ',') {
          this.next();
          list.push(this.expr());
        }
      }
      if (this.ty() !== ')') this.fail('Expected ")"');
      const end = this.next().span.end;
      return { t: 'in', e: l, list, span: { start: l.span.start, end } };
    }
    return l;
  }

  private additive(): SExpr {
    let l = this.multiplicative();
    while (this.op('+') || this.op('-') || this.op('.')) {
      const op = this.next().text as SBinOp;
      const r = this.multiplicative();
      l = { t: 'bin', op, l, r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }

  private multiplicative(): SExpr {
    let l = this.unary();
    while (this.op('*') || this.op('/') || this.op('%')) {
      const op = this.next().text as SBinOp;
      const r = this.unary();
      l = { t: 'bin', op, l, r, span: { start: l.span.start, end: r.span.end } };
    }
    return l;
  }

  private unary(): SExpr {
    if (this.op('-')) {
      const s = this.next().span.start;
      const e = this.guard(() => this.unary());
      if (e.t === 'num') return { t: 'num', v: `-${e.v}`, span: { start: s, end: e.span.end } };
      return { t: 'un', op: '-', e, span: { start: s, end: e.span.end } };
    }
    if (this.op('+')) {
      this.next();
      return this.guard(() => this.unary());
    }
    return this.primary();
  }

  private primary(): SExpr {
    const t = this.t;
    switch (t.type) {
      case 'num':
        this.next();
        return { t: 'num', v: t.text, span: t.span };
      case 'str':
        this.next();
        return { t: 'str', v: t.text, span: t.span };
      case 'field':
        this.next();
        return { t: 'field', name: t.text, span: t.span };
      case 'ident': {
        this.next();
        if (this.t.type === '(') {
          this.next();
          const args: SExpr[] = [];
          if (this.ty() !== ')') {
            args.push(this.expr());
            while (this.ty() === ',') {
              this.next();
              args.push(this.expr());
            }
          }
          if (this.ty() !== ')') this.fail('Expected ")" to close the function call');
          const end = this.next().span.end;
          return { t: 'call', fn: t.text.toLowerCase(), args, span: { start: t.span.start, end }, fnSpan: t.span };
        }
        return { t: 'field', name: t.text, span: t.span };
      }
      case '(': {
        this.next();
        const e = this.expr();
        if (this.ty() !== ')') this.fail('Expected ")"');
        this.next();
        return e;
      }
      default:
        return this.fail('Expected a value');
    }
  }
}

/** Every field referenced in an expression (not function names). */
export function fieldsIn(e: SExpr, out: Set<string> = new Set()): Set<string> {
  switch (e.t) {
    case 'field':
      out.add(e.name);
      break;
    case 'call':
      for (const a of e.args) fieldsIn(a, out);
      break;
    case 'un':
      fieldsIn(e.e, out);
      break;
    case 'bin':
      fieldsIn(e.l, out);
      fieldsIn(e.r, out);
      break;
    case 'in':
      fieldsIn(e.e, out);
      for (const a of e.list) fieldsIn(a, out);
      break;
    default:
      break;
  }
  return out;
}
