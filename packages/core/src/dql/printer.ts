import type { Span } from '../types.ts';
import { dict } from '../util/dict.ts';
import type { DqlArg, DqlCommand, DqlExpr, DqlQuery } from './ast.ts';

export interface PrintResult {
  text: string;
  /** Span of each top-level command's line(s), parallel to query.commands. */
  commandSpans: Span[];
}

/** The printed text would be longer than the length it was given (ADR-029). */
export class OutputTooLarge extends Error {}

/**
 * A field name holding a backtick, a carriage return or a line feed. No source confirms how DQL
 * writes such a name inside backticks, so it is never printed (ADR-029, rule 10).
 */
export class UnprintableName extends Error {
  readonly fieldName: string;
  constructor(fieldName: string) {
    super('A field name contains a backtick or a line break.');
    this.fieldName = fieldName;
  }
}

/**
 * Longest text the print in progress may produce. Every piece is checked as soon as it is built,
 * so a query whose text would grow far past the limit (a sub-query repeated inside itself) stops
 * early instead of being built first. Set only for the duration of one call below.
 */
let limit = Number.POSITIVE_INFINITY;

function fit(text: string): string {
  if (text.length > limit) throw new OutputTooLarge();
  return text;
}

/** Joins printed pieces, stopping as soon as the result would be longer than the limit. */
function joinFit<T>(items: readonly T[], print: (item: T) => string, separator: string): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    out = fit(i === 0 ? print(items[i] as T) : `${out}${separator}${print(items[i] as T)}`);
  }
  return out;
}

function withLimit<T>(max: number, run: () => T): T {
  const saved = limit;
  limit = Math.min(limit, max);
  try {
    return run();
  } finally {
    limit = saved;
  }
}

/**
 * The only place DQL text is produced. One command per line; continuation lines start with "| ".
 * With `maxLength`, throws OutputTooLarge as soon as the text would be longer.
 */
export function printQuery(query: DqlQuery, maxLength = Number.POSITIVE_INFINITY): PrintResult {
  return withLimit(maxLength, () => {
    const lines: string[] = [];
    const commandSpans: Span[] = [];
    let offset = 0;
    let first = true;
    for (const command of query.commands) {
      let line: string;
      if (command.name === '//') {
        line = `// ${oneLine(command.comment ?? '')}`;
      } else {
        line = `${first ? '' : '| '}${printCommand(command)}`;
        first = false;
      }
      commandSpans.push({ start: offset, end: offset + line.length });
      lines.push(line);
      offset += line.length + 1;
      if (offset - 1 > limit) throw new OutputTooLarge();
    }
    return { text: lines.join('\n'), commandSpans };
  });
}

/**
 * Length the given commands take when printed (each on its own line), without keeping the text.
 * Throws OutputTooLarge past `maxLength` and UnprintableName for a name DQL cannot hold.
 */
export function printedLength(commands: readonly DqlCommand[], maxLength: number): number {
  return withLimit(maxLength, () => {
    let total = 0;
    for (const command of commands) {
      total += (command.name === '//' ? oneLine(command.comment ?? '').length + 3 : printCommand(command).length + 2) + 1;
      if (total > limit) throw new OutputTooLarge();
    }
    return total;
  });
}

/** One expression as DQL text (for conditions stored in a mapping file). */
export function printExpression(e: DqlExpr): string {
  return printExpr(e, 0);
}

export function printCommand(command: DqlCommand): string {
  if (command.args.length === 0) return command.name;
  return fit(`${command.name} ${joinFit(command.args, (a) => printArg(a, true), ', ')}`);
}

function printArg(arg: DqlArg, inCommand: boolean): string {
  if (arg.kind === 'pos') return printExpr(arg.value, 0);
  // Command parameters are written `by:{…}`; function parameters `else: x`, as in Dynatrace's docs.
  return `${arg.name}:${inCommand ? '' : ' '}${printExpr(arg.value, 0)}`;
}

// Binding strength, weakest first.
const PREC: Readonly<Record<string, number>> = dict({
  or: 1,
  xor: 2,
  and: 3,
  not: 4,
  '==': 5,
  '!=': 5,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  in: 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
});
const UNARY_MINUS = 8;
const ATOM = 10;
const BOOLEAN_OPS = new Set(['or', 'xor', 'and']);

function precedence(e: DqlExpr): number {
  if (e.k === 'bin') return PREC[e.op] ?? ATOM;
  if (e.k === 'un') return e.op === 'not' ? (PREC.not ?? 4) : UNARY_MINUS;
  if (e.k === 'raw') return 0;
  if (e.k === 'num' && e.v.startsWith('-')) return UNARY_MINUS;
  if (e.k === 'time' && /^[-+]/.test(e.v)) return UNARY_MINUS;
  return ATOM;
}

/** Expressions nested deeper than this are not printed; the call stack would not hold them. */
const MAX_DEPTH = 1000;
let depth = 0;

function printExpr(e: DqlExpr, parentPrec: number): string {
  if (++depth > MAX_DEPTH) {
    depth--;
    throw new OutputTooLarge('The translated query is nested too deeply.');
  }
  try {
    const text = fit(printBare(e));
    return precedence(e) < parentPrec ? `(${text})` : text;
  } finally {
    depth--;
  }
}

function printBare(e: DqlExpr): string {
  switch (e.k) {
    case 'str':
    case 'dpl':
      return quote(e.v);
    case 'num':
      return e.v;
    case 'bool':
      return e.v ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'field':
      return fieldName(e.name);
    case 'ident':
    case 'time':
      return e.v;
    case 'call':
      return `${e.fn}(${joinFit(e.args, (a) => printArg(a, false), ', ')})`;
    case 'un':
      if (e.op === 'not') return e.e.k === 'bin' || e.e.k === 'raw' ? `not (${printBare(e.e)})` : `not ${printExpr(e.e, (PREC.not ?? 4) + 1)}`;
      return `-${printExpr(e.e, UNARY_MINUS)}`;
    case 'bin': {
      const p = PREC[e.op] ?? ATOM;
      // Walk the left spine iteratively: long and/or chains must not recurse once per operand.
      const rights: DqlExpr[] = [];
      let head: DqlExpr = e;
      while (head.k === 'bin' && head.op === e.op) {
        rights.push(head.r);
        head = head.l;
      }
      let out = printOperand(head, e.op, p, false);
      for (let i = rights.length - 1; i >= 0; i--) out = fit(`${out} ${e.op} ${printOperand(rights[i] as DqlExpr, e.op, p, true)}`);
      return out;
    }
    case 'block':
      return `{${joinFit(e.items, (i) => printExpr(i, 0), ', ')}}`;
    case 'assign':
      return `${fieldName(e.name)} = ${printExpr(e.e, 0)}`;
    case 'dir':
      return `${printExpr(e.e, 1)} ${e.dir}`;
    case 'index': {
      const base = printExpr(e.e, ATOM);
      if (e.key === undefined) return `${base}[]`;
      if (typeof e.key === 'number') return `${base}[${e.key}]`;
      return `${base}[${/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key) && !RESERVED.has(e.key) ? e.key : backtick(e.key)}]`;
    }
    case 'align':
      return `${printExpr(e.e, ATOM)}@${e.unit}`;
    case 'sub':
      return `[${joinFit(
        e.q.commands.filter((c) => c.name !== '//'),
        printCommand,
        ' | ',
      )}]`;
    case 'raw':
      return e.text;
    case 'var':
      return `$${e.name.replace(/[^A-Za-z0-9_]/g, '_')}${e.mod ? `:${e.mod}` : ''}`;
  }
}

function printOperand(child: DqlExpr, op: string, p: number, right: boolean): string {
  // Mixed and/or/xor are always parenthesised for readability.
  if (child.k === 'bin' && BOOLEAN_OPS.has(op) && BOOLEAN_OPS.has(child.op) && child.op !== op) {
    return `(${printBare(child)})`;
  }
  // Left-associative: an equal-precedence child on the right needs parentheses (a - (b - c)).
  return printExpr(child, right ? p + 1 : p);
}

const RESERVED = new Set(['true', 'false', 'null', 'and', 'or', 'not', 'xor', 'in', 'asc', 'desc']);
const PLAIN_FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function fieldName(name: string): string {
  if (PLAIN_FIELD.test(name) && !RESERVED.has(name)) return name;
  return backtick(name);
}

function backtick(name: string): string {
  // No escape for a backtick inside a backticked name is confirmed by any source; a line break
  // would end the name's line. Such a name is refused, never printed (ADR-029).
  if (/[`\r\n]/.test(name)) throw new UnprintableName(name);
  return `\`${name.replace(/\\/g, '\\\\').replace(CONTROL_ALL, '?')}\``;
}

// Control characters (terminal escapes among them) never reach printed DQL.
const CONTROL_ALL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;
const CONTROL_ONE = /^[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]$/;

/** A DQL double-quoted string literal. */
export function quote(v: string): string {
  let out = '"';
  for (const ch of v) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += CONTROL_ONE.test(ch) ? `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}` : ch;
    }
  }
  return `${out}"`;
}

function oneLine(text: string): string {
  // A newline in a comment would end it and turn the rest into DQL; never allow that.
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(CONTROL_ALL, '?');
}
