import { andAll, assign, block, call, cmd, cmdOf, type DqlArg, type DqlExpr, field, named, str, time } from '../dql/ast.ts';
import { isNumericAgg, lowerAgg, readAggList } from '../lower/aggs.ts';
import { type Stage, Untranslatable } from '../lower/context.ts';
import { type FixedSource, lowerLeadingSearch, lowerSearchExpr } from '../lower/search.ts';
import { findKeyword } from '../spl/scanner.ts';
import { parseSearch, SearchError, type SNode } from '../spl/search.ts';
import { dqlUnit } from '../spl/time.ts';
import type { DatamodelMapping, Span } from '../types.ts';
import { append } from '../util/array.ts';
import { dict } from '../util/dict.ts';
import { readFieldList } from './fields.ts';
import { type CommandDef, notTranslated } from './types.ts';

export const makeresults: CommandDef = {
  name: 'makeresults',
  tier: 'T2',
  summary: 'data record(timestamp = now()).',
  generating: true,
  lower(st) {
    const scan = st.scanner();
    for (let o = scan.option(); o; o = scan.option()) {
      if (o.name.toLowerCase() === 'count' && o.value === '1') continue;
      throw new Untranslatable('SPL2003', o.span, `makeresults ${o.name}=${o.value} cannot be translated.`);
    }
    st.emit(cmd('data', call('record', assign('timestamp', call('now')))));
    st.setTable(['timestamp']);
  },
};

function spanInterval(raw: string): DqlExpr | undefined {
  const m = /^(\d+)([A-Za-z]*)$/.exec(raw);
  const unit = m ? dqlUnit(m[2] || 's') : undefined;
  if (!m || !unit || unit === 'M' || unit === 'q' || unit === 'y') return undefined;
  return time(`${m[1]}${unit}`);
}

/** tstats options that only steer Splunk's index summaries; they change nothing about the events read. */
const TSTATS_IGNORED = new Set(['summariesonly', 'allow_old_summaries', 'local', 'chunk_size', 'include_reduced_buckets', 'use_summary_index_values']);

interface DatamodelSource {
  source: FixedSource;
}

/**
 * Starts a pipeline on a Splunk data model: looks the model (or `Model.Dataset`) up in the mapping
 * file, records it so `<dataset>.<field>` names resolve, and returns where to fetch from.
 */
function openDatamodel(st: Stage, path: string, span: Span): DatamodelSource {
  const clean = path.replace(/^"(.*)"$/, '$1').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(clean)) {
    throw new Untranslatable('SPL1003', span, `"${path}" is not a data model name.`);
  }
  const parts = clean.split('.');
  const model = parts[0] as string;
  let entry: DatamodelMapping | undefined;
  let matched = '';
  for (let n = parts.length; n > 0 && !entry; n--) {
    matched = parts.slice(0, n).join('.');
    entry = st.mapping.datamodels.get(matched);
  }
  // `Web.Web` or `Authentication.Authentication` is the model's root dataset: the model's entry is exact.
  const rootDataset = parts.length === 2 && parts[1] === parts[0];
  const wanted = rootDataset ? model : clean;
  if (!entry) {
    st.report('SPL4008', span, {
      subject: wanted,
      detail: `Data model "${wanted}" has no entry in the mapping file, so all records are read and its field names are kept.`,
    });
  } else if (matched !== clean && !rootDataset) {
    st.report('SPL4008', span, {
      subject: clean,
      detail: `Dataset "${clean}" has no entry of its own; the entry for "${matched}" is used, without the dataset's own constraint.`,
    });
  }
  st.state.datamodel = entry ? { model, key: matched, entry } : { model, key: wanted };
  const source: FixedSource = { dataObject: entry?.dataObject ?? st.mapping.defaults.dataObject, buckets: entry?.buckets ?? [] };
  if (entry?.filter !== undefined) source.filter = entry.filter;
  return { source };
}

/** Removes `nodename=Model.Dataset` from a tstats WHERE clause; it selects a dataset, it is not a filter. */
function takeNodename(tree: SNode | undefined): { tree: SNode | undefined; nodename?: string } {
  const isNode = (n: SNode): n is Extract<SNode, { t: 'cmp' }> => n.t === 'cmp' && n.field === 'nodename' && n.op === '=';
  if (!tree) return { tree };
  if (isNode(tree)) return { tree: undefined, nodename: tree.value };
  if (tree.t !== 'and') return { tree };
  const node = tree.items.find(isNode);
  if (!node) return { tree };
  const rest = tree.items.filter((i) => i !== node);
  return { tree: rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : { ...tree, items: rest }, nodename: node.value };
}

export const tstats: CommandDef = {
  name: 'tstats',
  tier: 'T2',
  summary: 'Runs on events: fetch + filter + summarize. A data model is read through its mapping entry.',
  generating: true,
  lower(st) {
    const text = st.tc.text;
    const scan = st.scanner();
    let prestats = false;
    let fillValue: string | undefined;
    for (let o = scan.option(); o; o = scan.option()) {
      const name = o.name.toLowerCase();
      if (TSTATS_IGNORED.has(name)) continue;
      if (name === 'prestats') prestats = /^(t|true|1)$/i.test(o.value);
      else if (name === 'fillnull_value') fillValue = o.value;
      else throw new Untranslatable('SPL2003', o.span, `tstats ${o.name}= cannot be translated.`);
    }
    const specs = readAggList(scan, st);
    let model: { path: string; span: Span } | undefined;
    if (scan.keyword('from')) {
      const o = scan.option();
      if (o?.name.toLowerCase() !== 'datamodel') {
        throw new Untranslatable('SPL4008', st.span, 'tstats from a namespace or a search id reads Splunk summaries; there is no equivalent.');
      }
      model = { path: o.value, span: o.span };
    }
    let whereEnd = st.argsSpan.end;
    let whereStart: number | undefined;
    if (scan.keyword('where')) {
      whereStart = scan.pos;
      const byAt = findKeyword(text, scan.pos, st.argsSpan.end, ['by']);
      whereEnd = byAt ? byAt.pos : st.argsSpan.end;
      scan.pos = whereEnd;
    }
    const by: { name: string; span: Span }[] = [];
    let interval: DqlExpr | undefined;
    if (scan.keyword('by')) {
      // span= may stand anywhere in the list: `by _time span=1h, host`.
      while (!scan.atEnd()) {
        const o = scan.option();
        if (o) {
          if (o.name.toLowerCase() === 'span') interval = spanInterval(o.value);
          if (!interval) throw new Untranslatable('SPL2003', o.span, `tstats ${o.name}=${o.value} cannot be translated.`);
          continue;
        }
        const before = scan.pos;
        append(by, readFieldList(scan));
        if (scan.pos === before) break;
      }
    }
    if (!scan.atEnd()) throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text in tstats.');
    let tree: ReturnType<typeof parseSearch>;
    try {
      tree = whereStart === undefined ? undefined : parseSearch(text, whereStart, whereEnd);
    } catch (e) {
      if (e instanceof SearchError) throw new Untranslatable('SPL1001', e.span, e.message);
      throw e;
    }
    st.report('SPL3014', st.span, { detail: 'tstats reads index summaries in Splunk; here it reads the events, which costs more.' });
    if (model) {
      const node = takeNodename(tree);
      tree = node.tree;
      lowerLeadingSearch(st, tree, openDatamodel(st, node.nodename ?? model.path, model.span).source);
    } else {
      lowerLeadingSearch(st, tree);
    }
    // prestats=t hands the events to the next reporting command (timechart, stats, chart), which
    // states the aggregation again; the result is the same as running that command on the events.
    if (prestats) return;

    const aggs = specs.map((s) => lowerAgg(s, st, 'table')).filter((a) => a !== undefined);
    if (aggs.length === 0) throw new Untranslatable('SPL2005', st.span, 'None of the aggregations can be translated.');
    const keys: DqlExpr[] = [];
    const names: string[] = [];
    for (const b of by) {
      const F = st.field(b.name, b.span);
      if (F === 'timestamp') {
        keys.push(assign('timestamp', call('bin', field('timestamp'), interval ?? time('1h'))));
        if (!interval) st.report('SPL3003', st.span, { detail: 'No span was given; one-hour buckets are used.' });
      } else {
        keys.push(field(F));
      }
      names.push(F);
    }
    // tstats leaves out rows with an empty BY field unless fillnull_value names a replacement.
    const groups = names.filter((n) => n !== 'timestamp');
    if (groups.length > 0 && fillValue !== undefined) {
      st.emit(
        cmdOf(
          'fieldsAdd',
          groups.map((g) => assign(g, call('coalesce', field(g), str(fillValue as string)))),
        ),
      );
    } else if (groups.length > 0) {
      st.emit(cmd('filter', andAll(groups.map((g) => call('isNotNull', field(g)))) as DqlExpr));
      st.report('SPL5003', st.span);
    }
    const aggArg = aggs.length === 1 ? assign(aggs[0]?.name ?? 'count', aggs[0]?.expr as DqlExpr) : block(aggs.map((a) => assign(a.name, a.expr)));
    st.emit(keys.length > 0 ? cmd('summarize', aggArg, named('by', block(keys))) : cmd('summarize', aggArg));
    st.setTable([...names, ...aggs.map((a) => a.name)]);
    for (const a of aggs) st.setType(a.name, a.time ? 'time' : isNumericAgg(a) ? 'number' : undefined);
  },
};

/** `| datamodel Model Dataset search` and `… flat`: the events of a data-model dataset. */
export const datamodel: CommandDef = {
  name: 'datamodel',
  tier: 'T2',
  summary: "datamodel <model> <dataset> search → fetch through the data model's mapping entry.",
  generating: true,
  lower(st) {
    const scan = st.scanner();
    const words: { value: string; span: Span }[] = [];
    for (;;) {
      const o = scan.option();
      if (o) {
        if (!TSTATS_IGNORED.has(o.name.toLowerCase()) && o.name.toLowerCase() !== 'strict_fields') {
          throw new Untranslatable('SPL2003', o.span, `datamodel ${o.name}= cannot be translated.`);
        }
        continue;
      }
      const w = scan.value();
      if (!w) break;
      words.push({ value: w.value, span: w.span });
    }
    const mode = words[2]?.value.toLowerCase();
    if (words.length !== 3 || (mode !== 'search' && mode !== 'flat')) {
      throw new Untranslatable('SPL4008', st.span, 'datamodel without "search" or "flat" returns the model\'s definition, not events.');
    }
    const path = `${(words[0] as { value: string }).value}.${(words[1] as { value: string }).value}`;
    lowerLeadingSearch(st, undefined, openDatamodel(st, path, st.span).source);
  },
};

/** `| from datamodel:Model.Dataset` */
export const fromCmd: CommandDef = {
  name: 'from',
  tier: 'T2',
  summary: "from datamodel:<model>.<dataset> → fetch through the data model's mapping entry.",
  generating: true,
  lower(st) {
    // Linear (ADR-029): the text is trimmed first, and "datamodel" is followed by either a colon
    // with optional blanks around it or by blanks — never by two blank runs next to each other.
    const m = /^datamodel(?:\s*:\s*|\s+)("?)([A-Za-z_][A-Za-z0-9_.]*)\1$/i.exec(st.slice(st.argsSpan).trim());
    if (!m) throw new Untranslatable('SPL4006', st.span, 'from a saved search or dataset cannot be resolved; translate that search itself.');
    lowerLeadingSearch(st, undefined, openDatamodel(st, m[2] as string, st.span).source);
  },
};

const METRIC_AGGS = dict({ avg: 'avg', mean: 'avg', sum: 'sum', min: 'min', max: 'max', count: 'count' });

export const mstats: CommandDef = {
  name: 'mstats',
  tier: 'T2',
  summary: 'timeseries a = avg(<metric key>), by:{…}, interval:….',
  generating: true,
  lower(st) {
    const text = st.tc.text;
    const scan = st.scanner();
    const leading = scan.option();
    if (leading) throw new Untranslatable('SPL2003', leading.span, `mstats ${leading.name}= cannot be translated.`);
    const specs = readAggList(scan, st);
    let filter: DqlExpr | undefined;
    if (scan.keyword('where')) {
      const start = scan.pos;
      const stop = findKeyword(text, start, st.argsSpan.end, ['by', 'span']);
      const end = stop ? stop.pos : st.argsSpan.end;
      let tree: ReturnType<typeof parseSearch>;
      try {
        tree = parseSearch(text, start, end);
      } catch (e) {
        if (e instanceof SearchError) throw new Untranslatable('SPL1001', e.span, e.message);
        throw e;
      }
      // index= in mstats picks the metric index; it has no equivalent and is dropped.
      const parts = tree ? (tree.t === 'and' ? tree.items : [tree]) : [];
      const kept = parts.filter((p) => !(p.t === 'cmp' && p.field === 'index'));
      st.state.schema = { kind: 'table', fields: [] };
      const exprs = kept.map((p) => lowerSearchExpr(p, st, text));
      st.state.schema = { kind: 'events', fields: [] };
      filter = andAll(exprs);
      scan.pos = end;
    }
    let interval: DqlExpr | undefined;
    let by: { name: string; span: { start: number; end: number } }[] = [];
    while (!scan.atEnd()) {
      const o = scan.option();
      if (o && o.name.toLowerCase() === 'span') {
        interval = spanInterval(o.value);
        if (!interval) throw new Untranslatable('SPL2003', o.span, `span=${o.value} cannot be translated.`);
        continue;
      }
      if (o) throw new Untranslatable('SPL2003', o.span, `mstats ${o.name}= cannot be translated.`);
      if (scan.keyword('by')) {
        by = readFieldList(scan, ['span']);
        continue;
      }
      throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text in mstats.');
    }
    const aggs: DqlExpr[] = [];
    const names: string[] = [];
    for (const s of specs) {
      const metric = s.fieldArg?.name;
      if (!metric) throw new Untranslatable('SPL1003', s.span, 'mstats aggregations need a metric name.');
      const key = st.mapping.metrics.get(metric);
      if (!key)
        st.report('SPL4007', s.fieldArg?.span ?? s.span, {
          subject: metric,
          detail: `Metric "${metric}" has no entry in the mapping file; its name was used as the metric key.`,
        });
      const fn = METRIC_AGGS[s.fn];
      const perc = /^(?:perc|p)(\d{1,2})$/.exec(s.fn);
      const name = s.alias ?? s.defaultName;
      const metricField = field(key ?? metric);
      if (fn) aggs.push(assign(name, call(fn, metricField)));
      else if (perc) aggs.push(assign(name, call('percentile', metricField, { k: 'num', v: perc[1] as string })));
      else throw new Untranslatable('SPL2005', s.span, `mstats ${s.fn}() cannot be translated.`);
      names.push(name);
    }
    if (aggs.length === 0) throw new Untranslatable('SPL1003', st.span, 'mstats needs an aggregation.');
    st.report('SPL3003', st.span, { detail: 'The result is one row per series with arrays of values.' });
    const byNames = by.map((b) => st.field(b.name, b.span));
    const args: (DqlExpr | DqlArg)[] = [aggs.length === 1 ? (aggs[0] as DqlExpr) : block(aggs)];
    if (byNames.length > 0) args.push(named('by', block(byNames.map(field))));
    if (filter) args.push(named('filter', filter));
    if (interval) args.push(named('interval', interval));
    st.emit(cmdOf('timeseries', args));
    st.state.schema = { kind: 'series', fields: ['timeframe', 'interval', ...byNames, ...names] };
    st.state.series = true;
  },
};

/** Commands with no translation (spl-dql-mapping.md §4.8 and §8 "never"). */
export const notTranslatedCommands: CommandDef[] = [
  notTranslated('pivot', 'SPL2002', 'pivot builds a report from a data model definition; write the search with stats instead.', [], true),
  notTranslated('iplocation', 'SPL2002', 'There is no IP geolocation function in DQL.'),
  notTranslated('geostats', 'SPL2002', 'geostats has no DQL equivalent.'),
  notTranslated('map', 'SPL2002', 'map runs a search per row; DQL has no equivalent.'),
  notTranslated('collect', 'SPL2008', 'collect writes to an index; it was dropped.'),
  notTranslated('outputlookup', 'SPL2008', 'outputlookup writes a lookup file; it was dropped.'),
  notTranslated('outputcsv', 'SPL2008', 'outputcsv writes a file; it was dropped.'),
  notTranslated('sendemail', 'SPL2008', 'sendemail sends e-mail; use a Dynatrace workflow instead.'),
  notTranslated('sendalert', 'SPL2008', 'sendalert triggers an alert action; use a Dynatrace workflow instead.'),
  notTranslated('delete', 'SPL2008', 'delete removes indexed data; it was dropped.'),
  notTranslated('mcollect', 'SPL2008', 'mcollect writes metrics; it was dropped.'),
  notTranslated('tscollect', 'SPL2008', 'tscollect writes summaries; it was dropped.'),
  notTranslated('predict', 'SPL2002', 'Forecasting belongs to Davis analyzers, not DQL.'),
  notTranslated('anomalydetection', 'SPL2002', 'Anomaly detection belongs to Davis analyzers, not DQL.'),
  notTranslated('anomalies', 'SPL2002', 'Anomaly detection belongs to Davis analyzers, not DQL.'),
  notTranslated('anomalousvalue', 'SPL2002', 'Anomaly detection belongs to Davis analyzers, not DQL.'),
  notTranslated('outlier', 'SPL2002', 'outlier has no DQL equivalent.'),
  notTranslated('cluster', 'SPL2002', 'Clustering has no DQL equivalent.'),
  notTranslated('kmeans', 'SPL2002', 'Clustering has no DQL equivalent.'),
  notTranslated('rest', 'SPL2002', 'rest reads the Splunk REST API; there is no equivalent.', [], true),
  notTranslated('metadata', 'SPL2002', 'metadata reads Splunk index metadata; there is no equivalent.', [], true),
  notTranslated('dbinspect', 'SPL2002', 'dbinspect reads Splunk buckets; there is no equivalent.', [], true),
  notTranslated('eventcount', 'SPL2002', 'eventcount reads index sizes; there is no equivalent.', [], true),
  notTranslated('loadjob', 'SPL2002', 'loadjob reads a Splunk job; there is no equivalent.', [], true),
  notTranslated('savedsearch', 'SPL4006', 'Saved searches cannot be resolved; translate the saved search itself.', [], true),
  notTranslated('script', 'SPL2002', 'Custom scripts have no DQL equivalent.'),
  notTranslated('appendcols', 'SPL2010', 'appendcols pastes rows by position; DQL has no equivalent.'),
  notTranslated('appendpipe', 'SPL2002', 'appendpipe has no DQL equivalent.'),
  notTranslated('xyseries', 'SPL2002', 'Pivoting rows into columns has no DQL equivalent.'),
  notTranslated('untable', 'SPL2002', 'Unpivoting columns into rows has no DQL equivalent.'),
  notTranslated('timewrap', 'SPL2002', 'timewrap has no DQL equivalent.'),
  notTranslated('addinfo', 'SPL2002', 'addinfo adds Splunk search metadata; there is no equivalent.'),
  notTranslated('addcoltotals', 'SPL2002', 'Adding a totals row has no DQL equivalent.'),
  notTranslated('transpose', 'SPL2002', 'transpose has no DQL equivalent.'),
  notTranslated('extract', 'SPL2002', 'Search-time key=value extraction: write a parse pattern with KVP by hand.', ['kv']),
  notTranslated('xmlkv', 'SPL2002', 'Search-time XML extraction has no DQL equivalent.'),
  notTranslated('multikv', 'SPL2002', 'Table extraction has no DQL equivalent.'),
  notTranslated('format', 'SPL2007', 'format builds search strings; there is no equivalent.'),
  notTranslated('gentimes', 'SPL2002', 'gentimes has no DQL equivalent.', [], true),
  notTranslated('inputcsv', 'SPL2002', 'inputcsv reads a file on the Splunk server; upload it as a lookup instead.', [], true),
  notTranslated('localize', 'SPL2002', 'localize has no DQL equivalent.'),
  notTranslated('concurrency', 'SPL2002', 'concurrency has no DQL equivalent.'),
  notTranslated('associate', 'SPL2002', 'associate has no DQL equivalent.'),
  notTranslated('correlate', 'SPL2002', 'correlate has no DQL equivalent.'),
  notTranslated('contingency', 'SPL2002', 'contingency has no DQL equivalent.', ['counttable', 'ctable']),
  notTranslated('arules', 'SPL2002', 'arules has no DQL equivalent.'),
  notTranslated('autoregress', 'SPL2002', 'autoregress depends on row order; there is no equivalent.'),
  notTranslated('filldown', 'SPL2010', 'filldown depends on row order; there is no equivalent.'),
  notTranslated('makecontinuous', 'SPL2002', 'makecontinuous has no DQL equivalent.'),
  notTranslated('setfields', 'SPL2002', 'setfields has no DQL equivalent.'),
  notTranslated('tags', 'SPL4006', 'Tags cannot be resolved without their definitions.'),
  notTranslated('typer', 'SPL4006', 'Event types cannot be resolved without their definitions.'),
  notTranslated('erex', 'SPL2002', 'erex generates a regex from examples; write the pattern by hand.'),
  notTranslated('scrub', 'SPL2002', 'scrub has no DQL equivalent.'),
  notTranslated('xpath', 'SPL2002', 'xpath has no DQL equivalent.'),
  notTranslated('sichart', 'SPL2002', 'Summary-indexing commands have no DQL equivalent.', ['sistats', 'sitimechart', 'sitop', 'sirare']),
];

export const generatingCommands: CommandDef[] = [makeresults, tstats, mstats, datamodel, fromCmd];
