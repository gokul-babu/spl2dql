/**
 * DQL abstract syntax tree. DQL text is produced from these nodes only by printer.ts (ADR-004).
 */

export type DqlExpr =
  | { k: 'str'; v: string }
  | { k: 'num'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  /** Field reference; the printer backticks it when needed. */
  | { k: 'field'; name: string }
  /** Bare identifier with fixed meaning in its position: a data object, `asc`, `leftOuter`. */
  | { k: 'ident'; v: string }
  /** Duration or time literal, already in DQL syntax: `5m`, `-24h@h`, `@d`, `now()-1d@d+2h`. */
  | { k: 'time'; v: string }
  | { k: 'call'; fn: string; args: DqlArg[] }
  | { k: 'un'; op: 'not' | '-'; e: DqlExpr }
  | { k: 'bin'; op: BinOp; l: DqlExpr; r: DqlExpr }
  /** `{a, b}` — array literal, or a block of assignments in summarize/fields. */
  | { k: 'block'; items: DqlExpr[] }
  /** `name = expr` inside an argument list or block. */
  | { k: 'assign'; name: string; e: DqlExpr }
  /** `expr asc` / `expr desc` in sort. */
  | { k: 'dir'; e: DqlExpr; dir: 'asc' | 'desc' }
  /** `e[key]` where key is a field name, or `e[n]`, or `e[]` when key is undefined. */
  | { k: 'index'; e: DqlExpr; key?: string | number }
  /** `e@unit`, e.g. `timestamp@M`. */
  | { k: 'align'; e: DqlExpr; unit: string }
  /** `[ sub-query ]` */
  | { k: 'sub'; q: DqlQuery }
  /** A Dynatrace pattern (DPL) string; printed as a string literal, triple-quoted when needed. */
  | { k: 'dpl'; v: string }
  /** Pre-validated DQL text from the mapping file (an expression). */
  | { k: 'raw'; text: string }
  /**
   * A Dynatrace dashboard variable: `$Name`, `$Name:noquote`, `$Name:backtick`, `$Name:triplequote`.
   * Only produced when a Splunk dashboard is converted (docs/spec/dashboards.md §5).
   */
  | { k: 'var'; name: string; mod?: VarModifier };

export type VarModifier = 'noquote' | 'backtick' | 'triplequote';

export type BinOp = 'or' | 'xor' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | '+' | '-' | '*' | '/' | '%';

export type DqlArg = { kind: 'pos'; value: DqlExpr } | { kind: 'named'; name: string; value: DqlExpr };

export interface DqlCommand {
  /** Command name, or "//" for a comment line. */
  name: string;
  args: DqlArg[];
  /** SPL stage indexes this command came from. */
  origin: number[];
  /** Text of a comment line (name === "//"). */
  comment?: string;
}

export interface DqlQuery {
  commands: DqlCommand[];
}

// ---------------------------------------------------------------------------------------------------
// Builders. Short names keep command modules readable.

export const str = (v: string): DqlExpr => ({ k: 'str', v });
export const num = (v: number | string): DqlExpr => ({ k: 'num', v: String(v) });
export const bool = (v: boolean): DqlExpr => ({ k: 'bool', v });
export const nul = (): DqlExpr => ({ k: 'null' });
export const field = (name: string): DqlExpr => ({ k: 'field', name });
export const ident = (v: string): DqlExpr => ({ k: 'ident', v });
export const time = (v: string): DqlExpr => ({ k: 'time', v });
export const dpl = (v: string): DqlExpr => ({ k: 'dpl', v });
export const raw = (text: string): DqlExpr => ({ k: 'raw', text });
export const variable = (name: string, mod?: VarModifier): DqlExpr => (mod ? { k: 'var', name, mod } : { k: 'var', name });
export const sub = (commands: DqlCommand[]): DqlExpr => ({ k: 'sub', q: { commands } });
export const block = (items: DqlExpr[]): DqlExpr => ({ k: 'block', items });
export const assign = (name: string, e: DqlExpr): DqlExpr => ({ k: 'assign', name, e });
export const dir = (e: DqlExpr, d: 'asc' | 'desc'): DqlExpr => ({ k: 'dir', e, dir: d });
export const not = (e: DqlExpr): DqlExpr => ({ k: 'un', op: 'not', e });
export const neg = (e: DqlExpr): DqlExpr => ({ k: 'un', op: '-', e });
export const bin = (op: BinOp, l: DqlExpr, r: DqlExpr): DqlExpr => ({ k: 'bin', op, l, r });
export const index = (e: DqlExpr, key?: string | number): DqlExpr => (key === undefined ? { k: 'index', e } : { k: 'index', e, key });
export const align = (e: DqlExpr, unit: string): DqlExpr => ({ k: 'align', e, unit });

export const pos = (value: DqlExpr): DqlArg => ({ kind: 'pos', value });
export const named = (name: string, value: DqlExpr): DqlArg => ({ kind: 'named', name, value });

export function call(fn: string, ...args: (DqlExpr | DqlArg)[]): DqlExpr {
  return { k: 'call', fn, args: args.map(toArg) };
}

export function cmd(name: string, ...args: (DqlExpr | DqlArg)[]): Omit<DqlCommand, 'origin'> {
  return { name, args: args.map(toArg) };
}

/**
 * `cmd` and `call` for a list read from the input: a spread (`cmd(name, ...list)`) passes every
 * item as an argument and a long list exceeds the call stack.
 */
export function cmdOf(name: string, args: readonly (DqlExpr | DqlArg)[]): Omit<DqlCommand, 'origin'> {
  return { name, args: args.map(toArg) };
}

export function callOf(fn: string, args: readonly (DqlExpr | DqlArg)[]): DqlExpr {
  return { k: 'call', fn, args: args.map(toArg) };
}

function toArg(a: DqlExpr | DqlArg): DqlArg {
  return 'kind' in a ? a : { kind: 'pos', value: a };
}

/** Joins expressions with `and`; returns undefined for an empty list. */
export function andAll(items: DqlExpr[]): DqlExpr | undefined {
  let out: DqlExpr | undefined;
  for (const item of items) out = out ? bin('and', out, item) : item;
  return out;
}

export function orAll(items: DqlExpr[]): DqlExpr | undefined {
  let out: DqlExpr | undefined;
  for (const item of items) out = out ? bin('or', out, item) : item;
  return out;
}

/** Deep copy; the AST is plain data. */
export function cloneCommand(c: DqlCommand): DqlCommand {
  return JSON.parse(JSON.stringify(c)) as DqlCommand;
}
