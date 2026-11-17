import type { Span } from '../types.ts';
import { type DqlToken, tokenizeDql } from './lexer.ts';

/**
 * A small recursive-descent DQL parser. It exists to check DQL offline (our own output, filters in
 * the mapping file, AI suggestions) and to back the local mock tenant. It accepts the DQL subset the
 * translator emits plus common hand-written forms; it is not a full DQL implementation.
 */

export interface ParsedCall {
  fn: string;
  span: Span;
  named: { name: string; span: Span }[];
}

export interface ParsedCommand {
  name: string;
  span: Span;
  named: { name: string; span: Span }[];
}

export interface ParseOutcome {
  /** Top-level and nested (sub-query) commands, in source order. */
  commands: ParsedCommand[];
  calls: ParsedCall[];
  error?: { message: string; span: Span };
}

const MAX_DEPTH = 256;
const MAX_LENGTH = 1_000_000;

export function parseDqlQuery(text: string): ParseOutcome {
  return run(text, (p) => {
    p.query();
    p.expectEof();
  });
}

/** Parses a single boolean or value expression (used for filters in the mapping file). */
export function parseDqlExpression(text: string): ParseOutcome {
  return run(text, (p) => {
    p.expr();
    p.expectEof();
  });
}

function run(text: string, body: (p: Parser) => void): ParseOutcome {
  const outcome: ParseOutcome = { commands: [], calls: [] };
  if (text.length > MAX_LENGTH) {
    outcome.error = { message: 'The query is too long.', span: { start: 0, end: 0 } };
    return outcome;
  }
  const parser = new Parser(
    tokenizeDql(text).filter((t) => t.type !== 'comment'),
    outcome,
  );
  try {
    body(parser);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    outcome.error = { message: e.message, span: e.span };
  }
  return outcome;
}

class ParseError extends Error {
  readonly span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.span = span;
  }
}

class Parser {
  private i = 0;
  private depth = 0;
  private readonly tokens: DqlToken[];
  private readonly out: ParseOutcome;

  constructor(tokens: DqlToken[], out: ParseOutcome) {
    this.tokens = tokens;
    this.out = out;
  }

  private get t(): DqlToken {
    return this.tokens[this.i] ?? (this.tokens[this.tokens.length - 1] as DqlToken);
  }
  private peek(n = 1): DqlToken {
    return this.tokens[this.i + n] ?? (this.tokens[this.tokens.length - 1] as DqlToken);
  }
  private is(text: string): boolean {
    return this.t.type === 'punct' && this.t.text === text;
  }
  private isWord(word: string): boolean {
    return this.t.type === 'ident' && this.t.text === word;
  }
  private next(): DqlToken {
    const tok = this.t;
    if (tok.type === 'error') throw new ParseError(describeError(tok), tok.span);
    this.i++;
    return tok;
  }
  private expect(text: string): DqlToken {
    if (!this.is(text)) this.fail(`Expected "${text}"`);
    return this.next();
  }
  private fail(message: string): never {
    const tok = this.t;
    if (tok.type === 'error') throw new ParseError(describeError(tok), tok.span);
    const found = tok.type === 'eof' ? 'end of query' : `"${tok.text}"`;
    throw new ParseError(`${message}, found ${found}.`, tok.span);
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ParseError('The query is nested too deeply.', this.t.span);
  }
  private leave(): void {
    this.depth--;
  }

  expectEof(): void {
    if (this.t.type !== 'eof') this.fail('Unexpected text');
  }

  query(): void {
    this.command();
    while (this.is('|')) {
      this.next();
      this.command();
    }
  }

  private command(): void {
    if (this.t.type !== 'ident') this.fail('Expected a command name');
    const nameTok = this.next();
    const command: ParsedCommand = { name: nameTok.text, span: nameTok.span, named: [] };
    this.out.commands.push(command);
    if (this.atArgsEnd()) return;
    this.argument(command.named);
    while (this.is(',')) {
      this.next();
      this.argument(command.named);
    }
    if (!this.atArgsEnd()) this.fail('Expected "," or "|"');
  }

  private atArgsEnd(): boolean {
    return this.t.type === 'eof' || this.is('|') || this.is(']');
  }

  private argument(named: { name: string; span: Span }[]): void {
    if (this.t.type === 'ident' && this.peek().type === 'punct' && this.peek().text === ':') {
      const nameTok = this.next();
      named.push({ name: nameTok.text, span: nameTok.span });
      this.next();
      this.valueWithDirection();
      return;
    }
    this.valueWithDirection();
  }

  private valueWithDirection(): void {
    this.assignOrExpr();
    if (this.isWord('asc') || this.isWord('desc')) this.next();
  }

  private assignOrExpr(): void {
    // name = expr   (single "=" is assignment; "==" is comparison)
    const save = this.i;
    if (this.t.type === 'backtick' || this.t.type === 'ident') {
      this.next();
      while (this.is('.') && (this.peek().type === 'ident' || this.peek().type === 'backtick')) {
        this.next();
        this.next();
      }
      if (this.is('=')) {
        this.next();
        this.expr();
        return;
      }
      this.i = save;
    }
    this.expr();
  }

  expr(): void {
    this.enter();
    this.binary(0);
    this.leave();
  }

  private static readonly LEVELS: readonly (readonly string[])[] = [
    ['or'],
    ['xor'],
    ['and'],
    ['==', '!=', '<', '<=', '>', '>=', 'in'],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private binary(level: number): void {
    const ops = Parser.LEVELS[level];
    if (!ops) {
      this.unary();
      return;
    }
    if (level === 3) {
      this.notLevel();
      return;
    }
    this.binary(level + 1);
    while (this.isOp(ops)) {
      this.next();
      this.binary(level + 1);
    }
  }

  // `not` binds tighter than and/or but looser than comparisons.
  private notLevel(): void {
    if (this.isWord('not')) {
      this.next();
      this.enter();
      this.notLevel();
      this.leave();
      return;
    }
    this.binary(4);
    const cmp = Parser.LEVELS[3] ?? [];
    while (this.isOp(cmp)) {
      this.next();
      this.binary(4);
    }
  }

  private isOp(ops: readonly string[]): boolean {
    const t = this.t;
    if (t.type === 'punct') return ops.includes(t.text);
    if (t.type === 'ident') return ops.includes(t.text);
    return false;
  }

  private unary(): void {
    if (this.is('-') || this.is('+')) {
      this.next();
      this.enter();
      this.unary();
      this.leave();
      return;
    }
    this.postfix();
  }

  private postfix(): void {
    this.primary();
    for (;;) {
      if (this.is('[')) {
        this.next();
        if (!this.is(']')) this.expr();
        this.expect(']');
      } else if (this.t.type === 'align') {
        this.next();
      } else {
        return;
      }
    }
  }

  private primary(): void {
    const t = this.t;
    switch (t.type) {
      case 'number':
      case 'duration':
      case 'string':
      case 'align':
        this.next();
        return;
      case 'backtick':
        this.next();
        return;
      case 'ident': {
        if (this.peek().type === 'punct' && this.peek().text === '(') {
          this.call();
          return;
        }
        this.next();
        while (this.is('.') && (this.peek().type === 'ident' || this.peek().type === 'backtick')) {
          this.next();
          this.next();
        }
        return;
      }
      case 'punct':
        if (t.text === '(') {
          this.next();
          this.expr();
          this.expect(')');
          return;
        }
        if (t.text === '{') {
          this.next();
          this.enter();
          if (!this.is('}')) {
            this.valueWithDirection();
            while (this.is(',')) {
              this.next();
              this.valueWithDirection();
            }
          }
          this.expect('}');
          this.leave();
          return;
        }
        if (t.text === '[') {
          this.next();
          this.enter();
          this.query();
          this.leave();
          this.expect(']');
          return;
        }
        this.fail('Expected a value');
        return;
      default:
        this.fail('Expected a value');
    }
  }

  private call(): void {
    const nameTok = this.next();
    const call: ParsedCall = { fn: nameTok.text, span: nameTok.span, named: [] };
    this.out.calls.push(call);
    this.expect('(');
    this.enter();
    if (!this.is(')')) {
      this.callArg(call);
      while (this.is(',')) {
        this.next();
        this.callArg(call);
      }
    }
    this.leave();
    this.expect(')');
  }

  private callArg(call: ParsedCall): void {
    if (this.t.type === 'ident' && this.peek().type === 'punct' && this.peek().text === ':') {
      const nameTok = this.next();
      call.named.push({ name: nameTok.text, span: nameTok.span });
      this.next();
    }
    this.assignOrExpr();
  }
}

function describeError(tok: DqlToken): string {
  if (tok.text.startsWith('"') || tok.text.startsWith("'")) return 'A string is not closed.';
  if (tok.text.startsWith('`')) return 'A backtick-quoted name is not closed.';
  return `Unexpected character "${tok.text}".`;
}
