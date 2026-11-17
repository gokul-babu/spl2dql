import { bin, call, callOf, type DqlExpr, field, named, num, str, time } from '../dql/ast.ts';
import { ExprError, parseExpr, type SExpr } from '../spl/expr.ts';
import { findClosing, type Scanner } from '../spl/scanner.ts';
import type { Span } from '../types.ts';
import { dict } from '../util/dict.ts';
import { type Stage, Untranslatable } from './context.ts';
import { lowerExpr } from './expr.ts';

/** One aggregation as written in stats/chart/timechart/eventstats. */
export interface AggSpec {
  fn: string;
  /** Field name argument (`avg(bytes)`), if any. */
  fieldArg?: { name: string; span: Span };
  /** Expression argument (`count(eval(x>1))`), if any. */
  evalArg?: SExpr;
  alias?: string;
  /** Splunk's default output name, e.g. "avg(bytes)". */
  defaultName: string;
  span: Span;
}

export type AggMode = 'table' | 'series';

export interface LoweredAgg {
  expr: DqlExpr;
  name: string;
  /** Order-dependent functions need the records sorted first. */
  order?: 'first' | 'last' | 'earliest' | 'latest';
  /** The result is a timestamp (min/max/first/last of a time field), so later arithmetic is typed. */
  time?: boolean;
}

const NUMERIC_RESULTS = new Set(['count', 'countIf', 'countDistinctExact', 'countDistinctApprox', 'sum', 'avg', 'median', 'percentile', 'stddev', 'variance']);

/** True when the aggregation always yields a number (used to type the output column). */
export function isNumericAgg(a: LoweredAgg): boolean {
  if (a.expr.k === 'bin') return true;
  return a.expr.k === 'call' && NUMERIC_RESULTS.has(a.expr.fn);
}

const STOP_WORDS = ['by', 'over', 'where', 'from'];
const OPTION_AHEAD = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/;

/**
 * Reads `fn(arg) [as alias]` items separated by optional commas, stopping before BY/OVER or the end.
 * Leading `name=value` options are returned separately.
 */
export function readAggList(scan: Scanner, st: Stage): AggSpec[] {
  const out: AggSpec[] = [];
  for (;;) {
    scan.skipWs();
    if (scan.atEnd()) break;
    if (STOP_WORDS.some((w) => scan.peekKeyword(w))) break;
    if (OPTION_AHEAD.test(st.tc.text.slice(scan.pos, Math.min(scan.end, scan.pos + 80)))) break;
    if (scan.eat(',')) continue;
    const start = scan.pos;
    const nameTok = scan.word('=(');
    if (!nameTok) throw new Untranslatable('SPL1003', scan.here(), 'Expected an aggregation such as count or avg(field).');
    const fn = nameTok.value.toLowerCase();
    let fieldArg: AggSpec['fieldArg'];
    let evalArg: SExpr | undefined;
    if (scan.peek() === '(' && scan.pos === nameTok.span.end) {
      const group = scan.balanced('(', ')');
      if (!group) throw new Untranslatable('SPL1003', nameTok.span, `The parentheses after ${fn} are not closed.`);
      const inner = st.tc.text.slice(group.inner.start, group.inner.end).trim();
      const evalMatch = /^eval\s*\(/i.exec(inner);
      if (evalMatch) {
        const innerStart = group.inner.start + st.tc.text.slice(group.inner.start, group.inner.end).indexOf('(') + 1;
        const close = findClosing(st.tc.text, innerStart - 1, group.inner.end, '(', ')');
        try {
          evalArg = parseExpr(st.tc.text, innerStart, close === -1 ? group.inner.end : close);
        } catch (e) {
          if (e instanceof ExprError) throw new Untranslatable('SPL1004', e.span, e.message);
          throw e;
        }
      } else if (inner !== '') {
        const lead = st.tc.text.slice(group.inner.start, group.inner.end).search(/\S/);
        const s = group.inner.start + Math.max(0, lead);
        fieldArg = { name: inner.replace(/^"(.*)"$/, '$1'), span: { start: s, end: s + inner.length } };
      }
    }
    const end = scan.pos;
    let alias: string | undefined;
    if (scan.keyword('as')) {
      const a = scan.fieldName();
      if (!a) throw new Untranslatable('SPL1003', scan.here(), 'Expected a name after AS.');
      alias = a.value;
    }
    const spec: AggSpec = {
      fn,
      defaultName: st.tc.text.slice(start, end).replace(/\s+/g, ''),
      span: { start, end: scan.pos },
    };
    if (fieldArg) spec.fieldArg = fieldArg;
    if (evalArg) spec.evalArg = evalArg;
    if (alias !== undefined) spec.alias = alias;
    out.push(spec);
  }
  return out;
}

/** Functions makeTimeseries accepts (series mode). */
export const SERIES_FUNCTIONS = new Set([
  'count',
  'c',
  'sum',
  'avg',
  'mean',
  'min',
  'max',
  'median',
  'dc',
  'distinct_count',
  'estdc',
  'per_second',
  'per_minute',
  'per_hour',
  'per_day',
]);

export function isSeriesCapable(spec: AggSpec): boolean {
  return SERIES_FUNCTIONS.has(spec.fn) || /^(perc|p|exactperc)\d{1,2}(\.\d+)?$/.test(spec.fn);
}

const RATE: Readonly<Record<string, string>> = dict({ per_second: '1s', per_minute: '1m', per_hour: '1h', per_day: '1d' });

/**
 * Lowers one aggregation (spl-dql-mapping.md §5). Returns undefined after reporting SPL2005 when the
 * function has no equivalent.
 */
export function lowerAgg(spec: AggSpec, st: Stage, mode: AggMode): LoweredAgg | undefined {
  const name = spec.alias ?? spec.defaultName;
  let argIsTime = false;
  const arg = (): DqlExpr => {
    if (spec.evalArg) {
      const lowered = lowerExpr(spec.evalArg, st);
      argIsTime = lowered.type === 'time';
      return lowered.e;
    }
    if (spec.fieldArg) {
      if (spec.fieldArg.name.includes('*'))
        throw new Untranslatable('SPL2009', spec.fieldArg.span, `${spec.fn}(${spec.fieldArg.name}) needs the list of fields.`);
      const F = st.field(spec.fieldArg.name, spec.fieldArg.span);
      argIsTime = st.fieldType(F) === 'time';
      return field(F);
    }
    throw new Untranslatable('SPL1003', spec.span, `${spec.fn}() needs a field.`);
  };
  /** An aggregation whose result has the type of its argument. */
  const sameType = (dqlFn: string, a: DqlExpr, order?: LoweredAgg['order']): LoweredAgg => {
    const out: LoweredAgg = { expr: call(dqlFn, a), name };
    if (order) out.order = order;
    if (argIsTime) out.time = true;
    return out;
  };
  const series = mode === 'series';
  const dflt = series ? [named('default', num(0))] : [];
  const fn = spec.fn;

  if (fn === 'count' || fn === 'c') {
    if (spec.evalArg) return { expr: call('countIf', lowerExpr(spec.evalArg, st).e, ...dflt), name };
    if (spec.fieldArg) return { expr: call('countIf', call('isNotNull', arg()), ...dflt), name };
    return { expr: callOf('count', dflt), name };
  }
  const perc = /^(perc|p|exactperc|upperperc)(\d{1,2}(?:\.\d+)?)$/.exec(fn);
  if (perc) {
    if (perc[1] === 'upperperc') return unsupported(spec, st, 'upperperc() has no DQL equivalent.');
    st.report('SPL3005', spec.span);
    return { expr: call('percentile', arg(), num(perc[2] as string)), name };
  }
  switch (fn) {
    case 'dc':
    case 'distinct_count':
      st.report('SPL5008', spec.span);
      return { expr: call('countDistinctExact', arg()), name };
    case 'estdc':
      return { expr: call('countDistinctApprox', arg()), name };
    case 'sum':
      return { expr: call(fn, arg()), name };
    case 'min':
    case 'max':
      return sameType(fn, arg());
    case 'avg':
    case 'mean':
      return { expr: call('avg', arg()), name };
    case 'range':
      return { expr: bin('-', call('max', arg()), call('min', arg())), name };
    case 'median':
      st.report('SPL3005', spec.span);
      return { expr: call('median', arg()), name };
    case 'stdev':
      return { expr: call('stddev', arg()), name };
    case 'stdevp':
      st.report('SPL3005', spec.span, { detail: 'stdevp() is the population deviation; DQL stddev() may use the sample formula.' });
      return { expr: call('stddev', arg()), name };
    case 'var':
      return { expr: call('variance', arg()), name };
    case 'varp':
      st.report('SPL3005', spec.span, { detail: 'varp() is the population variance; DQL variance() may use the sample formula.' });
      return { expr: call('variance', arg()), name };
    case 'sumsq': {
      const a = arg();
      return { expr: call('sum', bin('*', a, a)), name };
    }
    case 'values':
      return { expr: call('arraySort', call('collectDistinct', arg())), name };
    case 'list':
      st.report('SPL3004', spec.span, { detail: 'list() keeps event order and at most 100 values in Splunk; DQL order is not guaranteed.' });
      return { expr: call('collectArray', arg()), name };
    case 'first':
    case 'last':
    case 'earliest':
    case 'latest': {
      const a = arg();
      // The earliest/latest value of the event time itself is its minimum/maximum: no order needed.
      if ((fn === 'earliest' || fn === 'latest') && a.k === 'field' && a.name === 'timestamp') {
        return { expr: call(fn === 'earliest' ? 'min' : 'max', a), name, time: true };
      }
      st.report('SPL3004', spec.span);
      return sameType(fn === 'first' || fn === 'earliest' ? 'takeFirst' : 'takeLast', a, fn);
    }
    case 'earliest_time':
    case 'latest_time':
      st.report('SPL3006', spec.span, { detail: `${fn}() returns a timestamp in DQL, not Unix seconds.` });
      return { expr: call(fn === 'earliest_time' ? 'min' : 'max', field('timestamp')), name, time: true };
    case 'per_second':
    case 'per_minute':
    case 'per_hour':
    case 'per_day':
      if (!series) return unsupported(spec, st, `${fn}() is only translated in timechart.`);
      return { expr: call('sum', arg(), named('rate', time(RATE[fn] as string))), name };
    case 'mode':
    case 'rate':
    case 'sparkline':
      return unsupported(spec, st, `${fn}() has no DQL equivalent.`);
    default:
      return unsupported(spec, st, `${fn}() is not an aggregation the translator knows.`);
  }
}

function unsupported(spec: AggSpec, st: Stage, detail: string): undefined {
  st.report('SPL2005', spec.span, { detail });
  return undefined;
}

/** Adjusts first/last/earliest/latest after deciding on one sort direction. */
export function resolveOrder(aggs: LoweredAgg[], st: Stage): DqlExpr | undefined {
  const needsAsc = aggs.some((a) => a.order === 'earliest' || a.order === 'latest');
  const needsAny = aggs.some((a) => a.order !== undefined);
  if (!needsAny || !st.unorderedEvents) return undefined;
  if (needsAsc) {
    for (const a of aggs) {
      if (a.order === 'first' && a.expr.k === 'call') a.expr = { ...a.expr, fn: 'takeLast' };
      if (a.order === 'last' && a.expr.k === 'call') a.expr = { ...a.expr, fn: 'takeFirst' };
    }
    return str('asc');
  }
  return str('desc');
}
