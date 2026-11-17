import {
  align,
  andAll,
  assign,
  bin,
  block,
  call,
  callOf,
  cloneCommand,
  cmd,
  cmdOf,
  type DqlCommand,
  type DqlExpr,
  dir,
  field,
  ident,
  index,
  named,
  num,
  sub,
  time,
} from '../dql/ast.ts';
import { type AggSpec, isNumericAgg, isSeriesCapable, type LoweredAgg, lowerAgg, readAggList, resolveOrder } from '../lower/aggs.ts';
import { type Stage, Untranslatable } from '../lower/context.ts';
import type { Scanner } from '../spl/scanner.ts';
import { dqlUnit } from '../spl/time.ts';
import type { Span } from '../types.ts';
import { append } from '../util/array.ts';
import { dict } from '../util/dict.ts';
import { readFieldList } from './fields.ts';
import type { CommandDef } from './types.ts';

interface Option {
  name: string;
  value: string;
  span: Span;
}

function readOptions(scan: Scanner): Option[] {
  const out: Option[] = [];
  for (let o = scan.option(); o; o = scan.option()) out.push({ name: o.name.toLowerCase(), value: o.value, span: o.span });
  return out;
}

function lowerAll(aggs: AggSpec[], st: Stage, mode: 'table' | 'series'): LoweredAgg[] {
  const out: LoweredAgg[] = [];
  for (const a of aggs) {
    try {
      const l = lowerAgg(a, st, mode);
      if (l) out.push(l);
    } catch (e) {
      if (!(e instanceof Untranslatable)) throw e;
      st.report(e.code, e.span, { detail: `${e.message} This aggregation was left out.` });
    }
  }
  if (out.length === 0) throw new Untranslatable('SPL2005', st.span, 'None of the aggregations can be translated.');
  return out;
}

function typeAggs(st: Stage, aggs: LoweredAgg[]): void {
  for (const a of aggs) st.setType(a.name, a.time ? 'time' : isNumericAgg(a) ? 'number' : undefined);
}

function aggArg(aggs: LoweredAgg[]): DqlExpr {
  const items = aggs.map((a) => assign(a.name, a.expr));
  return items.length === 1 ? (items[0] as DqlExpr) : block(items);
}

function byFields(st: Stage, list: { name: string; span: Span }[]): string[] {
  return list.map((f) => {
    if (f.name.includes('*')) throw new Untranslatable('SPL2009', f.span, 'Grouping by a wildcard needs the list of fields.');
    return st.field(f.name, f.span);
  });
}

function emitOrderSort(st: Stage, aggs: LoweredAgg[]): void {
  const d = resolveOrder(aggs, st);
  if (d && d.k === 'str') {
    st.emit(cmd('sort', dir(field('timestamp'), d.v as 'asc' | 'desc')));
    st.report('SPL5004', st.span);
  }
}

function emitNullGuard(st: Stage, by: string[]): void {
  if (by.length === 0) return;
  st.emit(cmd('filter', andAll(by.map((b) => call('isNotNull', field(b)))) as DqlExpr));
  st.report('SPL5003', st.span);
}

export const stats: CommandDef = {
  name: 'stats',
  tier: 'T1',
  summary: 'summarize {…}, by:{…}; rows with an empty group are removed first, as in Splunk.',
  lower(st) {
    const scan = st.scanner();
    for (const o of readOptions(scan)) st.report('SPL2003', o.span, { detail: `stats ${o.name}= has no DQL equivalent and was ignored.` });
    const specs = readAggList(scan, st);
    const by = scan.keyword('by') ? readFieldList(scan) : [];
    if (!scan.atEnd()) throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text after the BY clause.');
    if (specs.length === 0) throw new Untranslatable('SPL1003', st.span, 'stats needs at least one aggregation.');
    const aggs = lowerAll(specs, st, 'table');
    const keys = byFields(st, by);
    emitOrderSort(st, aggs);
    emitNullGuard(st, keys);
    const args = [aggArg(aggs)];
    st.emit(keys.length > 0 ? cmd('summarize', ...args, named('by', block(keys.map(field)))) : cmdOf('summarize', args));
    st.setTable([...keys, ...aggs.map((a) => a.name)]);
    typeAggs(st, aggs);
  },
};

export const chart: CommandDef = {
  name: 'chart',
  tier: 'T1',
  summary: 'summarize by the over/by fields; two group fields give long rows instead of columns.',
  lower(st) {
    const scan = st.scanner();
    const opts = readOptions(scan);
    const specs = readAggList(scan, st);
    let over: { name: string; span: Span } | undefined;
    let by: { name: string; span: Span }[] = [];
    let binExpr: DqlExpr | undefined;
    if (scan.keyword('over')) {
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected a field after OVER.');
      over = { name: f.value, span: f.span };
      append(opts, readOptions(scan));
    }
    if (scan.keyword('by')) {
      by = readFieldList(scan);
      append(opts, readOptions(scan));
    }
    if (!scan.atEnd()) throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text in chart.');
    if (!over && by.length > 0) over = by.shift();
    if (by.length > 1) throw new Untranslatable('SPL2003', st.span, 'chart with more than two group fields has no equivalent.');
    const aggs = lowerAll(specs, st, 'table');
    const keys: DqlExpr[] = [];
    const names: string[] = [];
    if (over) {
      const O = st.field(over.name, over.span);
      for (const o of opts) {
        if (o.name === 'span' || o.name === 'bins') {
          const n = /^\d+(\.\d+)?$/.test(o.value) ? num(o.value) : undefined;
          if (!n) throw new Untranslatable('SPL2003', o.span, `chart ${o.name}=${o.value} cannot be translated.`);
          binExpr = assign(O, call('bin', field(O), n));
        }
      }
      keys.push(binExpr ?? field(O));
      names.push(O);
    }
    for (const b of by) {
      const B = st.field(b.name, b.span);
      keys.push(field(B));
      names.push(B);
    }
    for (const o of opts) {
      if (o.name === 'span' || o.name === 'bins') continue;
      if (['limit', 'useother', 'usenull', 'nullstr', 'otherstr'].includes(o.name)) {
        st.report('SPL3009', o.span, { detail: `chart ${o.name}= is not reproduced.` });
      } else {
        st.report('SPL2003', o.span, { detail: `chart ${o.name}= has no DQL equivalent and was ignored.` });
      }
    }
    if (by.length > 0) {
      st.report('SPL3003', st.span, { detail: 'chart over … by … gives one row per pair in DQL instead of one column per value.' });
      st.report('SPL3009', st.span, { detail: 'Splunk keeps the top 10 series and groups the rest as OTHER; DQL keeps all.' });
    }
    emitOrderSort(st, aggs);
    st.emit(keys.length > 0 ? cmd('summarize', aggArg(aggs), named('by', block(keys))) : cmd('summarize', aggArg(aggs)));
    st.setTable([...names, ...aggs.map((a) => a.name)]);
    typeAggs(st, aggs);
  },
};

/** Commands that may follow a series-mode timechart (they work on arrays). */
const SERIES_FOLLOWERS = new Set(['streamstats', 'accum', 'delta', 'trendline', 'fieldformat', 'highlight', 'iconify']);

export const timechart: CommandDef = {
  name: 'timechart',
  tier: 'T2',
  summary: 'makeTimeseries (series) or summarize by bin(timestamp, span) (tabular).',
  lower(st) {
    const scan = st.scanner();
    const opts = readOptions(scan);
    const specs = readAggList(scan, st);
    let by: { name: string; span: Span } | undefined;
    if (scan.keyword('by')) {
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected a field after BY.');
      by = { name: f.value, span: f.span };
      append(opts, readOptions(scan));
      if (scan.keyword('where')) {
        st.report('SPL2003', st.span, { detail: 'The WHERE clause of timechart (top series) is not reproduced.' });
        scan.rest();
      }
    }
    if (!scan.atEnd()) throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text in timechart.');
    if (specs.length === 0) throw new Untranslatable('SPL1003', st.span, 'timechart needs an aggregation.');

    let interval: DqlExpr | undefined;
    let calendar: string | undefined;
    let bins: DqlExpr | undefined;
    for (const o of opts) {
      if (o.name === 'span') {
        const m = /^(\d+)([A-Za-z]*)$/.exec(o.value);
        const unit = m ? dqlUnit(m[2] || 's') : undefined;
        if (!m || !unit) throw new Untranslatable('SPL2003', o.span, `span=${o.value} cannot be translated.`);
        if (unit === 'M' || unit === 'q' || unit === 'y') {
          if (m[1] !== '1') throw new Untranslatable('SPL2003', o.span, `span=${o.value} cannot be translated; only 1mon, 1q and 1y are.`);
          calendar = unit;
        } else {
          interval = time(`${m[1]}${unit}`);
        }
      } else if (o.name === 'bins' && /^\d+$/.test(o.value)) {
        bins = num(o.value);
      } else if (['limit', 'useother', 'usenull', 'nullstr', 'otherstr'].includes(o.name)) {
        // reported below with SPL3009
      } else {
        st.report('SPL2003', o.span, { detail: `timechart ${o.name}= has no DQL equivalent and was ignored.` });
      }
    }

    const followersOk = st.following.every((c) => SERIES_FOLLOWERS.has(c));
    const series = !calendar && followersOk && specs.every(isSeriesCapable);
    const aggs = lowerAll(specs, st, series ? 'series' : 'table');
    const B = by ? st.field(by.name, by.span) : undefined;
    st.report('SPL3003', st.span, {
      detail: series
        ? 'timechart gives one row per series with arrays of values in DQL.'
        : 'timechart gives one row per time bucket and series in DQL; empty buckets have no row.',
    });
    if (B) st.report('SPL3009', st.span, { detail: 'Splunk keeps the top 10 series and groups the rest as OTHER; DQL keeps all.' });

    if (series) {
      const args: (DqlExpr | ReturnType<typeof named>)[] = [aggArg(aggs)];
      if (B) args.push(named('by', block([field(B)])));
      if (interval) args.push(named('interval', interval));
      if (bins) args.push(named('bins', bins));
      st.emit(cmdOf('makeTimeseries', args));
      st.state.schema = { kind: 'series', fields: ['timeframe', 'interval', ...(B ? [B] : []), ...aggs.map((a) => a.name)] };
      st.state.series = true;
      st.state.sorted = true;
      return;
    }
    typeAggs(st, aggs);
    let bucket: DqlExpr;
    if (calendar) bucket = assign('timestamp', align(field('timestamp'), calendar));
    else {
      if (!interval) {
        st.report('SPL3003', st.span, { detail: 'No span was given; one-hour buckets are used.' });
        interval = time('1h');
      }
      bucket = assign('timestamp', call('bin', field('timestamp'), interval));
    }
    const keys = [bucket, ...(B ? [field(B)] : [])];
    emitOrderSort(st, aggs);
    st.emit(cmd('summarize', aggArg(aggs), named('by', block(keys))));
    st.setTable(['timestamp', ...(B ? [B] : []), ...aggs.map((a) => a.name)]);
  },
};

function topOrRare(name: 'top' | 'rare'): CommandDef {
  return {
    name,
    tier: 'T1',
    summary: name === 'top' ? 'Count by field, add percent, sort descending, limit.' : 'Count by field, add percent, sort ascending, limit.',
    lower(st) {
      const scan = st.scanner();
      let limit = scan.integer()?.value ?? 10;
      let countName = 'count';
      let percentName = 'percent';
      let showCount = true;
      let showPerc = true;
      const truthy = (v: string): boolean => /^(t|true|1)$/i.test(v);
      const list: { name: string; span: Span }[] = [];
      const by: { name: string; span: Span }[] = [];
      let inBy = false;
      // Options may appear before or after the field list.
      while (!scan.atEnd()) {
        const o = scan.option();
        if (o) {
          const key = o.name.toLowerCase();
          if (key === 'limit' && /^\d+$/.test(o.value)) limit = Number(o.value);
          else if (key === 'countfield') countName = o.value;
          else if (key === 'percentfield') percentName = o.value;
          else if (key === 'showcount') showCount = truthy(o.value);
          else if (key === 'showperc') showPerc = truthy(o.value);
          else st.report('SPL2003', o.span, { detail: `${name} ${o.name}= is not reproduced.` });
          continue;
        }
        if (scan.keyword('by')) {
          inBy = true;
          continue;
        }
        if (scan.eat(',')) continue;
        const f = scan.fieldName();
        if (!f) throw new Untranslatable('SPL1003', scan.here(), `Unexpected text in ${name}.`);
        (inBy ? by : list).push({ name: f.value, span: f.span });
      }
      if (list.length === 0) throw new Untranslatable('SPL1003', st.span, `${name} needs a field.`);
      const keys = byFields(st, list);
      const groups = byFields(st, by);
      const order = name === 'top' ? 'desc' : 'asc';
      const C = st.field(countName, st.span, true);
      st.setType(C, 'number');
      emitNullGuard(st, keys);

      if (groups.length > 0) {
        st.report('SPL3014', st.span, { detail: `${name} … by … sorts within each group but does not limit per group or add percentages.` });
        st.emit(cmd('summarize', assign(C, call('count')), named('by', block([...groups, ...keys].map(field)))));
        st.emit(cmd('sort', ...groups.map((g) => dir(field(g), 'asc')), dir(field(C), order)));
        st.setTable([...groups, ...keys, C]);
        return;
      }
      st.emit(cmd('summarize', assign(C, call('count')), named('by', block(keys.map(field)))));
      if (showPerc) {
        const P = st.field(percentName, st.span, true);
        st.setType(P, 'number');
        st.emit(
          cmd('summarize', block([assign('_r', call('collectArray', call('record', ...keys.map(field), field(C)))), assign('_total', call('sum', field(C)))])),
        );
        st.emit(cmd('expand', field('_r')));
        st.emit(
          cmd(
            'fields',
            ...keys.map((k) => assign(k, index(field('_r'), k))),
            assign(C, index(field('_r'), C)),
            assign(P, bin('/', bin('*', num('100.0'), index(field('_r'), C)), field('_total'))),
          ),
        );
        st.setTable([...keys, C, P]);
      } else {
        st.setTable([...keys, C]);
      }
      st.emit(cmd('sort', dir(field(C), order)));
      if (limit > 0) st.emit(cmd('limit', num(limit)));
      if (!showCount) {
        st.emit(cmd('fieldsRemove', field(C)));
        st.setTable(st.state.schema.fields.filter((f) => f !== C));
      }
      st.state.sorted = true;
    },
  };
}

export const top = topOrRare('top');
export const rare = topOrRare('rare');

export const eventstats: CommandDef = {
  name: 'eventstats',
  tier: 'T2',
  summary: 'Aggregates added to every row: collect-and-expand when the fields are known, otherwise a self-join.',
  lower(st) {
    const scan = st.scanner();
    for (const o of readOptions(scan)) st.report('SPL2003', o.span, { detail: `eventstats ${o.name}= was ignored.` });
    const specs = readAggList(scan, st);
    const by = scan.keyword('by') ? readFieldList(scan) : [];
    if (!scan.atEnd()) throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text after the BY clause.');
    const aggs = lowerAll(specs, st, 'table');
    const keys = byFields(st, by);
    const names = aggs.map((a) => a.name);
    for (const n of names) st.field(n, st.span, true);
    typeAggs(st, aggs);

    if (st.state.schema.kind === 'table') {
      // Strategy A: no re-execution.
      const rest = st.state.schema.fields.filter((f) => !keys.includes(f) && !names.includes(f));
      const summary = block([assign('_rows', call('collectArray', callOf('record', rest.map(field)))), ...aggs.map((a) => assign(a.name, a.expr))]);
      st.emit(keys.length > 0 ? cmd('summarize', summary, named('by', block(keys.map(field)))) : cmd('summarize', summary));
      st.emit(cmd('expand', field('_rows')));
      st.emit(cmd('fields', ...keys.map(field), ...rest.map((r) => assign(r, index(field('_rows'), r))), ...names.map(field)));
      st.setTable([...keys, ...rest, ...names]);
      return;
    }
    // Strategy B: join the pipeline so far with its own aggregate.
    st.report('SPL3012', st.span);
    const upstream: DqlCommand[] = st.upstream.filter((c) => c.name !== '//').map(cloneCommand);
    const constant = keys.length === 0;
    const joinKeys = constant ? ['_k'] : keys;
    if (constant) {
      st.emit(cmd('fieldsAdd', assign('_k', num(1))));
      upstream.push({ ...cmd('fieldsAdd', assign('_k', num(1))), origin: [st.index] });
    }
    upstream.push({ ...cmd('summarize', aggArg(aggs), named('by', block(joinKeys.map(field)))), origin: [st.index] });
    st.emit(cmd('join', sub(upstream), named('on', block(joinKeys.map(field))), named('kind', ident('leftOuter')), named('fields', block(names.map(field)))));
    if (constant) st.emit(cmd('fieldsRemove', field('_k')));
  },
};

/** streamstats/accum/delta/trendline: only as array functions right after a series-mode timechart. */
function seriesOnly(st: Stage, what: string): void {
  if (!st.prevSeries) {
    throw new Untranslatable('SPL2010', st.span, `${what} depends on the order of rows; it is only translated right after a timechart.`);
  }
}

const MOVING = dict({ sum: 'arrayMovingSum', avg: 'arrayMovingAvg', min: 'arrayMovingMin', max: 'arrayMovingMax' });

export const streamstats: CommandDef = {
  name: 'streamstats',
  tier: 'T3',
  summary: 'Not translated, except cumulative/windowed sums and averages right after timechart (array functions).',
  lower(st) {
    seriesOnly(st, 'streamstats');
    const scan = st.scanner();
    let window: number | undefined;
    for (const o of readOptions(scan)) {
      if (o.name === 'window' && /^\d+$/.test(o.value)) window = Number(o.value);
      else throw new Untranslatable('SPL2010', o.span, `streamstats ${o.name}= cannot be translated.`);
    }
    const specs = readAggList(scan, st);
    if (!scan.atEnd()) throw new Untranslatable('SPL2010', scan.here(), 'streamstats … by … cannot be translated.');
    const out: DqlExpr[] = [];
    for (const s of specs) {
      if (!s.fieldArg) throw new Untranslatable('SPL2010', s.span, `streamstats ${s.fn} cannot be translated.`);
      const F = field(st.field(s.fieldArg.name, s.fieldArg.span));
      const name = s.alias ?? s.defaultName;
      let fn: string | undefined;
      if (window === undefined || window === 0) fn = s.fn === 'sum' ? 'arrayCumulativeSum' : undefined;
      else fn = MOVING[s.fn];
      if (!fn) throw new Untranslatable('SPL2010', s.span, `streamstats ${s.fn}() ${window ? 'with a window' : 'without a window'} cannot be translated.`);
      out.push(assign(st.field(name, s.span, true), window ? call(fn, F, num(window)) : call(fn, F)));
    }
    st.emit(cmdOf('fieldsAdd', out));
    st.state.series = true;
  },
};

export const accum: CommandDef = {
  name: 'accum',
  tier: 'T2',
  summary: 'arrayCumulativeSum right after timechart.',
  lower(st) {
    seriesOnly(st, 'accum');
    const scan = st.scanner();
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'accum needs a field.');
    const target = scan.keyword('as') ? (scan.fieldName()?.value ?? f.value) : f.value;
    st.emit(cmd('fieldsAdd', assign(st.field(target, f.span, true), call('arrayCumulativeSum', field(st.field(f.value, f.span))))));
    st.state.series = true;
  },
};

export const delta: CommandDef = {
  name: 'delta',
  tier: 'T2',
  summary: 'arrayDelta right after timechart.',
  lower(st) {
    seriesOnly(st, 'delta');
    const scan = st.scanner();
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'delta needs a field.');
    const target = scan.keyword('as') ? (scan.fieldName()?.value ?? `delta(${f.value})`) : `delta(${f.value})`;
    const p = scan.option();
    if (p && !(p.name === 'p' && p.value === '1')) throw new Untranslatable('SPL2003', p.span, 'delta with p other than 1 cannot be translated.');
    st.emit(cmd('fieldsAdd', assign(st.field(target, f.span, true), call('arrayDelta', field(st.field(f.value, f.span))))));
    st.state.series = true;
  },
};

export const trendline: CommandDef = {
  name: 'trendline',
  tier: 'T2',
  summary: 'smaN → arrayMovingAvg right after timechart.',
  lower(st) {
    seriesOnly(st, 'trendline');
    const scan = st.scanner();
    const out: DqlExpr[] = [];
    while (!scan.atEnd()) {
      const fnTok = scan.word('(');
      const g = scan.balanced('(', ')');
      const m = fnTok ? /^sma(\d{1,4})$/i.exec(fnTok.value) : null;
      if (!fnTok || !g || !m) throw new Untranslatable('SPL2003', fnTok?.span ?? st.span, 'Only smaN(field) trendlines can be translated.');
      const src = st.slice(g.inner).trim();
      const target = scan.keyword('as') ? (scan.fieldName()?.value ?? `${fnTok.value}(${src})`) : `${fnTok.value}(${src})`;
      out.push(assign(st.field(target, fnTok.span, true), call('arrayMovingAvg', field(st.field(src, g.inner)), num(m[1] as string))));
    }
    st.emit(cmdOf('fieldsAdd', out));
    st.state.series = true;
  },
};

export const transaction: CommandDef = {
  name: 'transaction',
  tier: 'T2',
  summary: 'summarize start/end/eventcount/content by the fields; any option → not translated.',
  lower(st) {
    const scan = st.scanner();
    const list: { name: string; span: Span }[] = [];
    while (!scan.atEnd()) {
      if (scan.option()) throw new Untranslatable('SPL2002', st.span, 'transaction with options has no DQL equivalent.');
      if (scan.eat(',')) continue;
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL2002', st.span, 'transaction with options has no DQL equivalent.');
      list.push({ name: f.value, span: f.span });
    }
    if (list.length === 0) throw new Untranslatable('SPL2002', st.span, 'transaction without fields has no DQL equivalent.');
    const keys = byFields(st, list);
    st.report('SPL3014', st.span, { detail: 'transaction is approximated by grouping on the fields; time gaps and start/end markers are ignored.' });
    const content = st.field('_raw', st.span);
    st.emit(
      cmd(
        'summarize',
        block([
          assign('_start', call('min', field('timestamp'))),
          assign('_end', call('max', field('timestamp'))),
          assign('eventcount', call('count')),
          assign(content, call('collectArray', field(content))),
        ]),
        named('by', block(keys.map(field))),
      ),
    );
    st.emit(cmd('fieldsAdd', assign('duration', bin('/', bin('-', field('_end'), field('_start')), time('1s'))), assign('timestamp', field('_start'))));
    st.setTable([...keys, '_start', '_end', 'eventcount', content, 'duration', 'timestamp']);
    st.setType('eventcount', 'number');
    st.setType('duration', 'number');
  },
};

export const binCmd: CommandDef = {
  name: 'bin',
  aliases: ['bucket'],
  tier: 'T1',
  summary: 'fieldsAdd f = bin(f, span); calendar spans use @M/@q/@y.',
  lower(st) {
    const scan = st.scanner();
    const opts = readOptions(scan);
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'bin needs a field.');
    append(opts, readOptions(scan));
    let target = f.value;
    if (scan.keyword('as')) target = scan.fieldName()?.value ?? target;
    append(opts, readOptions(scan));
    const F = st.field(f.value, f.span);
    const isTime = F === 'timestamp' || st.fieldType(F) === 'time';
    const T = st.field(target, f.span, true);
    let span: Option | undefined;
    for (const o of opts) {
      if (o.name === 'span') span = o;
      else if (o.name === 'aligntime') st.report('SPL2003', o.span, { detail: 'aligntime= was ignored.' });
      else throw new Untranslatable('SPL2003', o.span, `bin ${o.name}= cannot be translated; use span=.`);
    }
    if (!span) throw new Untranslatable('SPL2003', st.span, 'bin without span= cannot be translated.');
    if (isTime) {
      const m = /^(\d+)([A-Za-z]*)$/.exec(span.value);
      const unit = m ? dqlUnit(m[2] || 's') : undefined;
      if (!m || !unit) throw new Untranslatable('SPL2003', span.span, `span=${span.value} cannot be translated.`);
      if (unit === 'M' || unit === 'q' || unit === 'y') {
        if (m[1] !== '1') throw new Untranslatable('SPL2003', span.span, `span=${span.value} cannot be translated.`);
        st.emit(cmd('fieldsAdd', assign(T, align(field(F), unit))));
      } else {
        st.emit(cmd('fieldsAdd', assign(T, call('bin', field(F), time(`${m[1]}${unit}`)))));
      }
    } else {
      if (!/^\d+(\.\d+)?$/.test(span.value)) throw new Untranslatable('SPL2003', span.span, `span=${span.value} cannot be translated for a number field.`);
      st.emit(cmd('fieldsAdd', assign(T, call('bin', field(F), num(span.value)))));
    }
    st.addFields([T]);
  },
};

export const statsCommands = [stats, chart, timechart, top, rare, eventstats, streamstats, accum, delta, trendline, transaction, binCmd];
