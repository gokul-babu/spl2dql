import { align, bin, block, bool, call, callOf, type DqlExpr, dpl, field, index as indexOf, named, neg, not, nul, num, str, time } from '../dql/ast.ts';
import type { SExpr } from '../spl/expr.ts';
import { parseSearch } from '../spl/search.ts';
import { dqlUnit } from '../spl/time.ts';
import type { Span } from '../types.ts';
import { dict } from '../util/dict.ts';
import { type Stage, Untranslatable } from './context.ts';
import { dplLiteral, regexLiteral, regexToDpl } from './regex.ts';
import { lowerSearchExpr } from './search.ts';
import { strftimeToDql } from './strftime.ts';

export type ExprType = 'time' | 'number' | 'string' | 'bool' | 'array' | 'unknown';

export interface Lowered {
  e: DqlExpr;
  type: ExprType;
  /** Statically a double (a decimal literal, toDouble(), a division), so dividing it keeps the fraction. */
  real?: boolean;
}

const DATE_FIELDS: Readonly<Record<string, string>> = dict({
  date_hour: 'getHour',
  date_minute: 'getMinute',
  date_mday: 'getDayOfMonth',
  date_month: 'getMonth',
  date_year: 'getYear',
  date_wday: 'getDayOfWeek',
});

/** Lowers an SPL eval/where expression. Throws Untranslatable for unsupported parts. */
export function lowerExpr(e: SExpr, st: Stage): Lowered {
  switch (e.t) {
    case 'str':
      return { e: str(e.v), type: 'string' };
    case 'num':
      return { e: num(normaliseNumber(e.v)), type: 'number', real: /[.eE]/.test(e.v) };
    case 'field':
      return lowerField(e.name, e.span, st);
    case 'un': {
      const inner = lowerExpr(e.e, st);
      if (e.op === 'NOT') return { e: not(inner.e), type: 'bool' };
      return { e: neg(inner.e), type: inner.type };
    }
    case 'in': {
      const target = lowerExpr(e.e, st);
      return { e: call('in', target.e, block(e.list.map((x) => lowerExpr(x, st).e))), type: 'bool' };
    }
    case 'bin':
      return lowerBinary(e, st);
    case 'call':
      return lowerCall(e, st);
  }
}

function lowerField(name: string, span: Span, st: Stage): Lowered {
  const dateFn = DATE_FIELDS[name];
  if (dateFn && !st.state.created.has(name)) {
    st.report('SPL3010', span, { subject: name, detail: `${name} is computed from the timestamp; Splunk returns text and uses the user's time zone.` });
    return { e: call(dateFn, field('timestamp')), type: 'number' };
  }
  const dqlName = st.field(name, span);
  const t = st.fieldType(dqlName);
  return { e: field(dqlName), type: t === 'time' ? 'time' : t === 'number' ? 'number' : t === 'string' ? 'string' : 'unknown' };
}

function lowerBinary(e: Extract<SExpr, { t: 'bin' }>, st: Stage): Lowered {
  const l = lowerExpr(e.l, st);
  const r = lowerExpr(e.r, st);
  switch (e.op) {
    case 'AND':
      return { e: bin('and', l.e, r.e), type: 'bool' };
    case 'OR':
      return { e: bin('or', l.e, r.e), type: 'bool' };
    case 'XOR':
      return { e: bin('xor', l.e, r.e), type: 'bool' };
    case 'LIKE':
      return { e: call('like', l.e, r.e), type: 'bool' };
    case '.':
      return { e: concat(l.e, r.e), type: 'string' };
    case '=':
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const op = e.op === '=' ? '==' : e.op;
      if ((l.type === 'time' && r.type === 'number') || (l.type === 'number' && r.type === 'time')) {
        st.report('SPL3006', e.span, { detail: 'A timestamp is compared with a number; it is compared as Unix seconds.' });
        const lt = l.type === 'time' ? call('unixSecondsFromTimestamp', l.e) : l.e;
        const rt = r.type === 'time' ? call('unixSecondsFromTimestamp', r.e) : r.e;
        return { e: bin(op, lt, rt), type: 'bool' };
      }
      warnUntyped(st, e.l, l, r);
      warnUntyped(st, e.r, r, l);
      return { e: bin(op, l.e, r.e), type: 'bool' };
    }
    case '+':
      if (l.type === 'string' && r.type === 'string') return { e: concat(l.e, r.e), type: 'string' };
      return timeArith('+', l, r);
    case '-':
      if (l.type === 'time' && r.type === 'time') {
        return { e: bin('/', bin('-', l.e, r.e), time('1s')), type: 'number', real: true };
      }
      return timeArith('-', l, r);
    case '*':
    case '/':
    case '%': {
      // A Splunk time is a number of seconds; a DQL timestamp cannot be multiplied or divided.
      const a = asSeconds(l);
      const b = asSeconds(r);
      if (e.op === '/') return { e: divide(a, b), type: 'number', real: true };
      return { e: bin(e.op, a.e, b.e), type: 'number', real: (a.real ?? false) || (b.real ?? false) };
    }
  }
}

function asSeconds(x: Lowered): Lowered {
  return x.type === 'time' ? { e: call('unixSecondsFromTimestamp', x.e), type: 'number' } : x;
}

/**
 * Splunk always divides with a fraction (5/2 = 2.5). DQL drops the fraction when both sides are whole
 * numbers, so one side is made a double unless it already is one.
 */
function divide(l: Lowered, r: Lowered): DqlExpr {
  if (l.real || r.real) return bin('/', l.e, r.e);
  if (r.e.k === 'num' && /^\d+$/.test(r.e.v)) return bin('/', l.e, num(`${r.e.v}.0`));
  if (l.e.k === 'num' && /^\d+$/.test(l.e.v)) return bin('/', num(`${l.e.v}.0`), r.e);
  return bin('/', call('toDouble', l.e), r.e);
}

function warnUntyped(st: Stage, raw: SExpr, side: Lowered, other: Lowered): void {
  if (raw.t === 'field' && side.type === 'unknown' && other.type === 'number' && side.e.k === 'field') {
    st.report('SPL3006', raw.span, {
      subject: `type:${side.e.name}`,
      detail: `"${raw.name}" has no declared type; DQL will not compare text with a number the way Splunk does.`,
    });
  }
}

function timeArith(op: '+' | '-', l: Lowered, r: Lowered): Lowered {
  // Splunk times are epoch seconds, so a number added to a time is a number of seconds.
  if (l.type === 'time' && (r.type === 'number' || r.type === 'unknown')) {
    if (r.e.k === 'num' && /^\d+$/.test(r.e.v)) return { e: bin(op, l.e, time(`${r.e.v}s`)), type: 'time' };
    return { e: bin(op, l.e, bin('*', r.e, time('1s'))), type: 'time' };
  }
  return { e: bin(op, l.e, r.e), type: l.type === 'number' && r.type === 'number' ? 'number' : 'unknown', real: (l.real ?? false) || (r.real ?? false) };
}

/** DQL numbers start and end with a digit: .5 → 0.5, 5. → 5.0 */
export function normaliseNumber(v: string): string {
  return v.replace(/^(-?)\./, '$10.').replace(/\.(?=$|[eE])/, '.0');
}

function concat(a: DqlExpr, b: DqlExpr): DqlExpr {
  const parts = (x: DqlExpr): DqlExpr[] => (x.k === 'call' && x.fn === 'concat' ? x.args.map((p) => p.value) : [x]);
  return call('concat', ...parts(a), ...parts(b));
}

type Handler = (args: SExpr[], st: Stage, node: Extract<SExpr, { t: 'call' }>) => Lowered;

const same =
  (dqlName: string, type: ExprType = 'unknown', arity?: number): Handler =>
  (args, st, node) => {
    if (arity !== undefined && args.length !== arity) throw arityError(node, arity);
    return { e: call(dqlName, ...args.map((a) => lowerExpr(a, st).e)), type };
  };

/**
 * The first argument of a function that needs one. Lowering the call itself in its place (as these
 * handlers once did) recursed until the stack ran out; no argument is an expression error.
 */
function first(args: readonly SExpr[], node: Extract<SExpr, { t: 'call' }>): SExpr {
  const a = args[0];
  if (a === undefined) throw new Untranslatable('SPL1004', node.span, `${node.fn}() expects at least 1 argument.`);
  return a;
}

const unsupported: Handler = (_args, _st, node) => {
  throw new Untranslatable('SPL2004', node.fnSpan, `${node.fn}() has no DQL equivalent.`);
};

function arityError(node: Extract<SExpr, { t: 'call' }>, n: number): Untranslatable {
  return new Untranslatable('SPL1004', node.span, `${node.fn}() expects ${n} argument${n === 1 ? '' : 's'}.`);
}

function literalString(e: SExpr | undefined, node: Extract<SExpr, { t: 'call' }>, what: string): string {
  if (e?.t !== 'str') throw new Untranslatable('SPL2004', node.span, `${node.fn}() needs ${what} as a quoted literal to be translated.`);
  return e.v;
}

function literalInt(e: SExpr | undefined): number | undefined {
  if (e?.t !== 'num' || !/^-?\d+$/.test(e.v)) return undefined;
  return Number(e.v);
}

const FUNCTIONS: Readonly<Record<string, Handler>> = dict({
  if: (args, st, node) => {
    if (args.length !== 3) throw arityError(node, 3);
    const [c, a, b] = args.map((x) => lowerExpr(x, st));
    return { e: call('if', (c as Lowered).e, (a as Lowered).e, named('else', (b as Lowered).e)), type: (a as Lowered).type };
  },
  case: (args, st, node) => {
    if (args.length < 2 || args.length % 2 !== 0) throw new Untranslatable('SPL1004', node.span, 'case() needs condition/value pairs.');
    const pairs: [SExpr, SExpr][] = [];
    for (let i = 0; i < args.length; i += 2) pairs.push([args[i] as SExpr, args[i + 1] as SExpr]);
    let elseExpr: DqlExpr | undefined;
    const last = pairs[pairs.length - 1];
    if (last && isAlwaysTrue(last[0])) {
      elseExpr = lowerExpr(last[1], st).e;
      pairs.pop();
    }
    let out = elseExpr;
    for (let i = pairs.length - 1; i >= 0; i--) {
      const [c, v] = pairs[i] as [SExpr, SExpr];
      const ce = lowerExpr(c, st).e;
      const ve = lowerExpr(v, st).e;
      out = out === undefined ? call('if', ce, ve) : call('if', ce, ve, named('else', out));
    }
    return { e: out ?? nul(), type: 'unknown' };
  },
  coalesce: same('coalesce'),
  nullif: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    const a = lowerExpr(args[0] as SExpr, st);
    const b = lowerExpr(args[1] as SExpr, st);
    return { e: call('if', bin('==', a.e, b.e), nul(), named('else', a.e)), type: a.type };
  },
  isnull: same('isNull', 'bool', 1),
  isnotnull: same('isNotNull', 'bool', 1),
  isnum: typeTest((x) => call('in', call('type', x), block([str('long'), str('double')]))),
  isint: typeTest((x) => bin('==', call('type', x), str('long'))),
  isstr: typeTest((x) => bin('==', call('type', x), str('string'))),
  isbool: typeTest((x) => bin('==', call('type', x), str('boolean'))),
  typeof: (args, st, node) => {
    const x = first(args, node);
    st.report('SPL3006', node.span, { detail: 'typeof() returns DQL type names (long, double, string …), not Splunk ones.' });
    return { e: call('type', lowerExpr(x, st).e), type: 'string' };
  },
  len: same('stringLength', 'number', 1),
  lower: same('lower', 'string', 1),
  upper: same('upper', 'string', 1),
  trim: (args, st, node) => {
    if (args.length !== 1) throw new Untranslatable('SPL2004', node.span, 'trim() with a character list has no DQL equivalent.');
    return { e: call('trim', lowerExpr(args[0] as SExpr, st).e), type: 'string' };
  },
  ltrim: unsupported,
  rtrim: unsupported,
  substr: lowerSubstr,
  replace: (args, st, node) => {
    if (args.length !== 3) throw arityError(node, 3);
    const s = lowerExpr(args[0] as SExpr, st).e;
    const re = literalString(args[1], node, 'the regular expression');
    const rep = literalString(args[2], node, 'the replacement');
    if (/\\\d/.test(rep)) throw new Untranslatable('SPL2006', node.span, 'Back-references in the replacement have no DQL equivalent.');
    const lit = regexLiteral(re);
    if (lit !== undefined) return { e: call('replaceString', s, str(lit), str(rep)), type: 'string' };
    const conv = regexToDpl(re, {});
    if (!conv.ok) throw new Untranslatable('SPL2006', (args[1] as SExpr).span, conv.reason);
    st.report('SPL3008', (args[1] as SExpr).span);
    return { e: call('replacePattern', s, dpl(stripDataPrefix(conv.dpl)), str(rep)), type: 'string' };
  },
  split: same('splitString', 'array', 2),
  mvindex: (args, st, node) => {
    const m = lowerExpr(first(args, node), st).e;
    const a = literalInt(args[1]);
    if (args.length === 2) {
      if (a === undefined) throw new Untranslatable('SPL2004', node.span, 'mvindex() needs a literal position to be translated.');
      return { e: indexOf(m, a), type: 'unknown' };
    }
    if (args.length !== 3) throw arityError(node, 3);
    const b = literalInt(args[2]);
    if (a === undefined || b === undefined) {
      st.report('SPL3007', node.span);
      const from = lowerExpr(args[1] as SExpr, st).e;
      const to = bin('+', lowerExpr(args[2] as SExpr, st).e, num(1));
      return { e: call('arraySlice', m, named('from', from), named('to', to)), type: 'array' };
    }
    if (b === -1) return { e: call('arraySlice', m, named('from', num(a))), type: 'array' };
    return { e: call('arraySlice', m, named('from', num(a)), named('to', num(b + 1))), type: 'array' };
  },
  mvcount: (args, st, node) => {
    st.report('SPL3013', node.span, { detail: 'mvcount() counts array elements; a single value that is not an array has no count in DQL.' });
    return { e: call('arraySize', lowerExpr(first(args, node), st).e), type: 'number' };
  },
  mvjoin: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    return { e: call('arrayToString', lowerExpr(args[0] as SExpr, st).e, named('delimiter', lowerExpr(args[1] as SExpr, st).e)), type: 'string' };
  },
  mvappend: (args, st) => ({
    e: callOf(
      'arrayConcat',
      args.map((a) => call('toArray', lowerExpr(a, st).e)),
    ),
    type: 'array',
  }),
  mvdedup: same('arrayDistinct', 'array', 1),
  mvsort: same('arraySort', 'array', 1),
  mvfilter: (args, st, node) => {
    const cond = args[0];
    const fields = new Set<string>();
    if (cond) collectFields(cond, fields);
    if (!cond || fields.size !== 1) throw new Untranslatable('SPL2004', node.span, 'mvfilter() can only be translated when the condition uses one field.');
    const name = [...fields][0] as string;
    const dqlName = st.field(name, node.span);
    const lowered = lowerExpr(cond, st).e;
    const rewritten = rewriteField(lowered, dqlName);
    return { e: call('arrayRemoveNulls', call('iCollectArray', call('if', rewritten, indexOf(field(dqlName))))), type: 'array' };
  },
  mvfind: unsupported,
  mvzip: unsupported,
  mvrange: unsupported,
  mvmap: unsupported,
  tostring: (args, st, node) => {
    const x = lowerExpr(first(args, node), st).e;
    if (args.length === 1) return { e: call('toString', x), type: 'string' };
    const fmt = literalString(args[1], node, 'the format');
    if (fmt === 'hex') return { e: call('concat', str('0x'), call('numberToHexString', x)), type: 'string' };
    throw new Untranslatable('SPL2004', node.span, `tostring() with format "${fmt}" has no DQL equivalent.`);
  },
  tonumber: (args, st, node) => {
    const x = lowerExpr(first(args, node), st).e;
    if (args.length === 1) return { e: call('toDouble', x), type: 'number', real: true };
    if (literalInt(args[1]) === 16) return { e: call('hexStringToNumber', x), type: 'number' };
    if (literalInt(args[1]) === 10) return { e: call('toDouble', x), type: 'number', real: true };
    throw new Untranslatable('SPL2004', node.span, 'tonumber() only translates for base 10 and 16.');
  },
  round: (args, st, node) => {
    const x = lowerExpr(first(args, node), st).e;
    if (args.length === 1) return { e: call('round', x), type: 'number' };
    const n = literalInt(args[1]);
    if (n !== undefined && n < 0) throw new Untranslatable('SPL2004', node.span, 'round() to negative decimals has no DQL equivalent.');
    return { e: call('round', x, named('decimals', lowerExpr(args[1] as SExpr, st).e)), type: 'number' };
  },
  floor: same('floor', 'number', 1),
  ceil: same('ceil', 'number', 1),
  ceiling: same('ceil', 'number', 1),
  abs: same('abs', 'number', 1),
  sqrt: same('sqrt', 'number', 1),
  exp: same('exp', 'number', 1),
  pow: same('power', 'number', 2),
  ln: same('log', 'number', 1),
  log: (args, st, node) => {
    const x = lowerExpr(first(args, node), st).e;
    if (args.length === 1) return { e: call('log10', x), type: 'number' };
    return { e: bin('/', call('log', x), call('log', lowerExpr(args[1] as SExpr, st).e)), type: 'number' };
  },
  pi: same('pi', 'number', 0),
  exact: (args, st, node) => lowerExpr(first(args, node), st),
  sigfig: unsupported,
  printf: unsupported,
  max: minMax('arrayMax'),
  min: minMax('arrayMin'),
  random: () => ({ e: call('toLong', bin('*', call('random'), num(2147483647))), type: 'number' }),
  like: same('like', 'bool', 2),
  match: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    const s = lowerExpr(args[0] as SExpr, st).e;
    const re = literalString(args[1], node, 'the regular expression');
    const conv = regexToDpl(re, { forMatch: true });
    if (!conv.ok) throw new Untranslatable('SPL2006', (args[1] as SExpr).span, conv.reason);
    st.report('SPL3008', (args[1] as SExpr).span);
    return { e: call('matchesPattern', s, dpl(conv.dpl)), type: 'bool' };
  },
  searchmatch: (args, st, node) => {
    const arg = args[0];
    if (arg?.t !== 'str') throw new Untranslatable('SPL2004', node.span, 'searchmatch() needs a quoted search.');
    // The search text sits inside quotes in the original; re-parse it from its own string.
    const sub = arg.v;
    const tree = parseSearch(sub, 0, sub.length);
    st.report('SPL3011', node.span);
    if (!tree) return { e: bool(true), type: 'bool' };
    return { e: lowerSearchExpr(tree, st, sub, true), type: 'bool' };
  },
  cidrmatch: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    return { e: call('ipIn', lowerExpr(args[1] as SExpr, st).e, lowerExpr(args[0] as SExpr, st).e), type: 'bool' };
  },
  in: (args, st, node) => {
    if (args.length < 2) throw arityError(node, 2);
    return { e: call('in', lowerExpr(args[0] as SExpr, st).e, block(args.slice(1).map((a) => lowerExpr(a, st).e))), type: 'bool' };
  },
  md5: same('hashMd5', 'string', 1),
  sha1: same('hashSha1', 'string', 1),
  sha256: same('hashSha256', 'string', 1),
  sha512: same('hashSha512', 'string', 1),
  urldecode: same('decodeUrl', 'string', 1),
  spath: jsonPathFn,
  json_extract: jsonPathFn,
  validate: unsupported,
  true: () => ({ e: bool(true), type: 'bool' }),
  false: () => ({ e: bool(false), type: 'bool' }),
  null: () => ({ e: nul(), type: 'unknown' }),
  now: () => ({ e: call('now'), type: 'time' }),
  time: () => ({ e: call('now'), type: 'time' }),
  relative_time: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    const t = lowerExpr(args[0] as SExpr, st);
    const mod = literalString(args[1], node, 'the time modifier');
    return { e: relativeTime(t.type === 'time' ? t.e : call('timestampFromUnixSeconds', call('toLong', t.e)), mod, node), type: 'time' };
  },
  strftime: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    const t = lowerExpr(args[0] as SExpr, st);
    const fmt = literalString(args[1], node, 'the format');
    const ts = t.type === 'time' ? t.e : call('timestampFromUnixSeconds', call('toLong', t.e));
    if (fmt === '%s') return { e: call('unixSecondsFromTimestamp', ts), type: 'number' };
    const conv = strftimeToDql(fmt);
    if (!conv.ok) throw new Untranslatable('SPL2004', (args[1] as SExpr).span, `The format directive ${conv.directive} has no DQL equivalent.`);
    st.report('SPL3010', node.span);
    return { e: call('formatTimestamp', ts, named('format', str(conv.format))), type: 'string' };
  },
  strptime: (args, st, node) => {
    if (args.length !== 2) throw arityError(node, 2);
    const s = lowerExpr(args[0] as SExpr, st).e;
    const fmt = literalString(args[1], node, 'the format');
    const conv = strftimeToDql(fmt);
    if (!conv.ok) throw new Untranslatable('SPL2004', (args[1] as SExpr).span, `The format directive ${conv.directive} has no DQL equivalent.`);
    st.report('SPL3010', node.span);
    return { e: call('parse', s, dpl(`TIMESTAMP(${dplLiteral(conv.format)}):t`)), type: 'time' };
  },
});

function typeTest(build: (x: DqlExpr) => DqlExpr): Handler {
  return (args, st, node) => {
    const x = first(args, node);
    st.report('SPL3006', node.span, { detail: `${node.fn}() tests the stored type in DQL, not whether the text looks like a number.` });
    return { e: build(lowerExpr(x, st).e), type: 'bool' };
  };
}

function minMax(fn: string): Handler {
  return (args, st, node) => {
    st.report('SPL3006', node.span, { detail: `${node.fn}() of several values ignores values that are not numbers in DQL.` });
    return {
      e: call(
        fn,
        callOf(
          'array',
          args.map((a) => lowerExpr(a, st).e),
        ),
      ),
      type: 'number',
    };
  };
}

function jsonPathFn(args: SExpr[], st: Stage, node: Extract<SExpr, { t: 'call' }>): Lowered {
  if (args.length !== 2) throw arityError(node, 2);
  const s = lowerExpr(args[0] as SExpr, st).e;
  const path = literalString(args[1], node, 'the path');
  return { e: call('jsonPath', s, str(splunkPathToJsonPath(path))), type: 'unknown' };
}

/** Splunk spath path (a.b{}.c, a{0}) → JSONPath ($.a.b[*].c, $.a[0]). */
export function splunkPathToJsonPath(path: string): string {
  return `$.${path.replace(/\{\}/g, '[*]').replace(/\{(\d+)\}/g, '[$1]')}`;
}

function lowerSubstr(args: SExpr[], st: Stage, node: Extract<SExpr, { t: 'call' }>): Lowered {
  if (args.length < 2 || args.length > 3) throw arityError(node, 3);
  const s = lowerExpr(args[0] as SExpr, st).e;
  const start = literalInt(args[1]);
  const len = args.length === 3 ? literalInt(args[2]) : undefined;
  if (start !== undefined && (args.length === 2 || len !== undefined)) {
    if (start < 0) {
      if (len === undefined) return { e: call('substring', s, named('from', num(start))), type: 'string' };
      const to = start + len;
      return to >= 0
        ? { e: call('substring', s, named('from', num(start))), type: 'string' }
        : { e: call('substring', s, named('from', num(start)), named('to', num(to))), type: 'string' };
    }
    const from = Math.max(0, start - 1);
    if (len === undefined) return { e: call('substring', s, named('from', num(from))), type: 'string' };
    return { e: call('substring', s, named('from', num(from)), named('to', num(from + len))), type: 'string' };
  }
  st.report('SPL3007', node.span);
  const from = bin('-', lowerExpr(args[1] as SExpr, st).e, num(1));
  if (args.length === 2) return { e: call('substring', s, named('from', from)), type: 'string' };
  return { e: call('substring', s, named('from', from), named('to', bin('+', from, lowerExpr(args[2] as SExpr, st).e))), type: 'string' };
}

function relativeTime(t: DqlExpr, mod: string, node: Extract<SExpr, { t: 'call' }>): DqlExpr {
  const m = /^([+-]\d+)([A-Za-z]*)?(?:@([A-Za-z]+\d?))?$/.exec(mod.trim()) ?? /^()()@([A-Za-z]+\d?)$/.exec(mod.trim());
  if (!m) throw new Untranslatable('SPL2004', node.span, `relative_time() with "${mod}" cannot be translated.`);
  let out = t;
  if (m[1]) {
    const unit = dqlUnit(m[2] || 's');
    if (!unit) throw new Untranslatable('SPL2004', node.span, `Unknown time unit in "${mod}".`);
    const n = m[1].replace(/^[+-]/, '');
    out = bin(m[1].startsWith('-') ? '-' : '+', out, time(`${n}${unit}`));
  }
  if (m[3]) {
    const raw = m[3].toLowerCase();
    const unit = raw.startsWith('w') ? (raw === 'w' || raw === 'w7' ? 'w0' : raw) : dqlUnit(raw);
    if (!unit) throw new Untranslatable('SPL2004', node.span, `Unknown snap unit in "${mod}".`);
    out = align(out, unit);
  }
  return out;
}

function lowerCall(node: Extract<SExpr, { t: 'call' }>, st: Stage): Lowered {
  const handler = Object.hasOwn(FUNCTIONS, node.fn) ? FUNCTIONS[node.fn] : undefined;
  if (!handler) throw new Untranslatable('SPL2004', node.fnSpan, `${node.fn}() is not a function the translator knows.`);
  return handler(node.args, st, node);
}

function isAlwaysTrue(e: SExpr): boolean {
  if (e.t === 'call' && e.fn === 'true' && e.args.length === 0) return true;
  if (e.t === 'bin' && (e.op === '=' || e.op === '==') && e.l.t === 'num' && e.r.t === 'num' && e.l.v === e.r.v) return true;
  return false;
}

function collectFields(e: SExpr, out: Set<string>): void {
  if (e.t === 'field') out.add(e.name);
  else if (e.t === 'call') for (const a of e.args) collectFields(a, out);
  else if (e.t === 'un') collectFields(e.e, out);
  else if (e.t === 'bin') {
    collectFields(e.l, out);
    collectFields(e.r, out);
  } else if (e.t === 'in') {
    collectFields(e.e, out);
    for (const a of e.list) collectFields(a, out);
  }
}

function rewriteField(e: DqlExpr, name: string): DqlExpr {
  if (e.k === 'field' && e.name === name) return indexOf(e);
  if (e.k === 'call') return { ...e, args: e.args.map((a) => ({ ...a, value: rewriteField(a.value, name) })) };
  if (e.k === 'un') return { ...e, e: rewriteField(e.e, name) };
  if (e.k === 'bin') return { ...e, l: rewriteField(e.l, name), r: rewriteField(e.r, name) };
  if (e.k === 'block') return { ...e, items: e.items.map((i) => rewriteField(i, name)) };
  return e;
}

function stripDataPrefix(p: string): string {
  return p.startsWith('DATA? ') ? p.slice(6) : p;
}
