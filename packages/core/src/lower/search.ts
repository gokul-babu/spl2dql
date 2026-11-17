import { andAll, bin, block, bool, call, cmd, type DqlExpr, field, ident, named, not, num, orAll, pos, raw, str, time } from '../dql/ast.ts';
import type { SNode } from '../spl/search.ts';
import { parseTimeModifier, type TimeValue } from '../spl/time.ts';
import type { Span } from '../types.ts';
import { append } from '../util/array.ts';
import { type Stage, Untranslatable } from './context.ts';

const NUMBER = /^-?\d+(\.\d+)?$/;
const SPECIAL = new Set(['index', 'sourcetype', 'eventtype', 'tag', 'earliest', 'latest']);
const INDEX_TIME = /^_index_(earliest|latest)$/;

/**
 * Lowers a search expression to one DQL boolean expression. A top-level `NOT p` comes back as
 * isFalseOrNull(p) so the caller can emit it as `filterOut p`. Returns undefined when nothing is left
 * (only dropped parts such as unresolved macros).
 */
export function lowerSearchExpr(node: SNode, st: Stage, _text: string, inExpression = false, spanOverride?: Span): DqlExpr {
  return lowerNode(node, st, inExpression, spanOverride) ?? bool(true);
}

function lowerNode(node: SNode, st: Stage, inExpr: boolean, so: Span | undefined): DqlExpr | undefined {
  const sp = (s: Span): Span => so ?? s;
  switch (node.t) {
    case 'and':
      return andAll(node.items.map((n) => lowerNode(n, st, inExpr, so)).filter((x): x is DqlExpr => x !== undefined));
    case 'or':
      return orAll(node.items.map((n) => lowerNode(n, st, inExpr, so)).filter((x): x is DqlExpr => x !== undefined));
    case 'not': {
      const inner = lowerNode(node.e, st, inExpr, so);
      return inner === undefined ? undefined : call('isFalseOrNull', inner);
    }
    case 'macro':
      return undefined;
    case 'sub':
      return st.tc.lowerSubsearchFilter(node, st);
    case 'term':
      return termExpr(node.v, node.quoted, false, st, sp(node.span));
    case 'func':
      if (node.fn === 'CASE') return termExpr(node.v, true, true, st, sp(node.span));
      st.report('SPL3011', sp(node.span), { detail: 'TERM() matches a whole token in Splunk; in DQL it becomes a phrase match.' });
      return termExpr(node.v, true, false, st, sp(node.span));
    case 'in':
      return inExpr_(node, st, sp(node.span));
    case 'cmp':
      return cmpExpr(node, st, sp(node.span), sp(node.fieldSpan));
  }
}

function termExpr(v: string, quoted: boolean, caseSensitive: boolean, st: Stage, span: Span): DqlExpr {
  if (st.state.schema.kind !== 'events') {
    throw new Untranslatable('SPL2003', span, 'A free-text term after a transforming command can only stand on its own in the search.');
  }
  if (!quoted && v.includes('*')) {
    st.report('SPL3011', span, { detail: `"${v}": wildcard terms match on token boundaries that differ from Splunk's.` });
  }
  const content = field(st.field('_raw', span));
  const args = [content, str(v)];
  return caseSensitive ? call('matchesPhrase', ...args, named('caseSensitive', bool(true))) : call('matchesPhrase', ...args);
}

function inExpr_(node: Extract<SNode, { t: 'in' }>, st: Stage, span: Span): DqlExpr {
  const F = st.field(node.field, span);
  const type = st.fieldType(F);
  const allNumeric = node.values.length > 0 && node.values.every((v) => !v.quoted && NUMBER.test(v.v));
  if (allNumeric && type !== 'string') {
    // Same rule as field=number: compared as a number unless the field is declared as text.
    if (type !== 'number') {
      st.report('SPL3006', span, { subject: `type:${F}`, detail: `"${node.field}" has no declared type; it is compared as a number.` });
    }
    return call('in', field(F), block(node.values.map((v) => num(v.v))));
  }
  return call('matchesValue', field(F), block(node.values.map((v) => str(v.v))));
}

function cmpExpr(node: Extract<SNode, { t: 'cmp' }>, st: Stage, span: Span, fieldSpan: Span): DqlExpr | undefined {
  const name = node.field;
  if (name === 'earliest' || name === 'latest' || INDEX_TIME.test(name)) {
    throw new Untranslatable('SPL2003', span, 'A time modifier can only be translated as a top-level term of the first search.');
  }
  if (name === 'sourcetype' || name === 'eventtype' || name === 'tag') return mappedCondition(node, st, span);
  if (name === 'index' && st.first) {
    st.report('SPL3014', span, { detail: 'An index inside OR/NOT is translated as a bucket comparison.' });
    const idx = st.mapping.indexes.get(node.value);
    const bucket = idx?.buckets[0] ?? node.value;
    const e = bin('==', field('dt.system.bucket'), str(bucket));
    return node.op === '!=' ? not(e) : e;
  }

  const F = st.field(name, fieldSpan);
  const type = st.fieldType(F);
  const value = node.value;
  const numeric = !node.quoted && NUMBER.test(value);
  const untyped = (): void => {
    if (type === undefined) {
      st.report('SPL3006', fieldSpan, {
        subject: `type:${F}`,
        detail: `"${name}" has no declared type; it is compared as a ${numeric ? 'number' : 'text'}.`,
      });
    }
  };
  switch (node.op) {
    case '=':
    case '!=': {
      let e: DqlExpr;
      if (value === '*' && !node.quoted) {
        if (node.op === '!=') {
          st.report('SPL3002', span, { detail: `${name}!=* is translated as "field is missing".` });
          return call('isNull', field(F));
        }
        return call('isNotNull', field(F));
      }
      if (numeric && type !== 'string') {
        if (type !== 'number') untyped();
        e = bin(node.op === '=' ? '==' : '!=', field(F), num(value));
        return e;
      }
      if (/.\*./.test(value)) {
        st.report('SPL3011', span, { detail: `"${value}": a wildcard in the middle of a value may match differently.` });
      }
      e = call('matchesValue', field(F), str(value));
      return node.op === '!=' ? not(e) : e;
    }
    default: {
      untyped();
      return bin(node.op, field(F), numeric ? num(value) : str(value));
    }
  }
}

/** sourcetype=, eventtype=, tag= inside an expression: the mapped DQL condition, or "true". */
function mappedCondition(node: Extract<SNode, { t: 'cmp' }>, st: Stage, span: Span): DqlExpr | undefined {
  const m = st.mapping;
  const filter =
    node.field === 'sourcetype' ? m.sourcetypes.get(node.value)?.filter : node.field === 'eventtype' ? m.eventtypes.get(node.value) : m.tags.get(node.value);
  if (filter === undefined) {
    const code = node.field === 'sourcetype' ? 'SPL4002' : 'SPL4006';
    st.report(code, span, {
      subject: `${node.field}=${node.value}`,
      detail: `${node.field} "${node.value}" has no entry in the mapping file, so it was left out; the result may include more records.`,
    });
    return undefined;
  }
  return node.op === '!=' ? not(raw(filter)) : raw(filter);
}

// ---------------------------------------------------------------------------------------------------
// Statement-level emission

function conjuncts(node: SNode | undefined): SNode[] {
  if (!node) return [];
  return node.t === 'and' ? node.items : [node];
}

/** Emits `filter …` for the remaining conjuncts and `filterOut p` for each top-level NOT. */
function emitFilters(st: Stage, exprs: DqlExpr[]): void {
  const keep: DqlExpr[] = [];
  const drop: DqlExpr[] = [];
  for (const e of exprs) {
    if (e.k === 'call' && e.fn === 'isFalseOrNull' && e.args.length === 1 && e.args[0]) drop.push(e.args[0].value);
    else keep.push(e);
  }
  const joined = andAll(keep);
  if (joined) st.emit(cmd('filter', joined));
  for (const d of drop) st.emit(cmd('filterOut', d));
}

/** Where the records come from when it is not an index: a data model's entry in the mapping file. */
export interface FixedSource {
  dataObject: string;
  buckets: readonly string[];
  filter?: string;
}

/**
 * The first search of a pipeline: `fetch` + filters (spl-dql-mapping.md §3). With `source` the data
 * object and buckets are given (a data model); an `index=` term is then an ordinary condition.
 */
export function lowerLeadingSearch(st: Stage, root: SNode | undefined, source?: FixedSource): void {
  const m = st.mapping;
  const rest: SNode[] = [];
  const indexTerms: Extract<SNode, { t: 'cmp' }>[] = [];
  const rawFilters: DqlExpr[] = [];
  let earliest: { value: TimeValue; span: Span } | undefined;
  let latest: { value: TimeValue; span: Span } | undefined;

  for (const c of conjuncts(root)) {
    if (!source && c.t === 'cmp' && c.field === 'index' && c.op === '=') {
      indexTerms.push(c);
    } else if (!source && c.t === 'or' && c.items.length > 0 && c.items.every((i) => i.t === 'cmp' && i.field === 'index' && i.op === '=')) {
      append(indexTerms, c.items as Extract<SNode, { t: 'cmp' }>[]);
    } else if (c.t === 'cmp' && (c.field === 'earliest' || c.field === 'latest') && c.op === '=') {
      // On a dashboard `earliest=$time.earliest$` is the time picker: Dynatrace applies its own.
      if (st.tc.options.tokens && /^\$[A-Za-z_][A-Za-z0-9_.]*\$$/.test(c.value)) continue;
      const value = parseTimeModifier(c.value, m.defaults.timezone);
      if (c.field === 'earliest') earliest = { value, span: c.span };
      else latest = { value, span: c.span };
    } else if (c.t === 'cmp' && INDEX_TIME.test(c.field)) {
      st.report('SPL2011', c.span, { detail: `${c.field} (index time) has no DQL equivalent and was left out.` });
    } else if (c.t === 'cmp' && SPECIAL.has(c.field) && c.op === '=' && c.field !== 'index') {
      const e = mappedCondition(c, st, c.span);
      if (e) rawFilters.push(e);
    } else {
      rest.push(c);
    }
  }

  // Data source
  let dataObject = m.defaults.dataObject;
  let buckets: string[] = [];
  if (source) {
    dataObject = source.dataObject;
    buckets = [...source.buckets];
    if (source.filter !== undefined) rawFilters.unshift(raw(source.filter));
  } else if (indexTerms.length === 0) {
    st.report('SPL4001', st.span, {
      subject: '(none)',
      detail: 'The search names no index; Splunk would search your default indexes, DQL reads all records of this type.',
    });
  } else {
    const objects = new Set<string>();
    let anyUnmapped = false;
    let anyStar = false;
    for (const t of indexTerms) {
      if (t.value === '*') {
        anyStar = true;
        continue;
      }
      const idx = lookupIndex(m.indexes, t.value);
      if (!idx) {
        anyUnmapped = true;
        st.report('SPL4001', t.span, { subject: t.value, detail: `Index "${t.value}" has no entry in the mapping file, so all records are read.` });
        continue;
      }
      objects.add(idx.dataObject);
      append(buckets, idx.buckets);
      if (idx.filter !== undefined && indexTerms.length === 1) rawFilters.unshift(raw(idx.filter));
    }
    if (objects.size > 1) {
      throw new Untranslatable('SPL2003', st.span, 'These indexes map to different Grail data objects; split the search.');
    }
    if (objects.size === 1) dataObject = [...objects][0] as string;
    if (anyUnmapped || anyStar) buckets = [];
  }

  const fetchArgs = [pos(ident(dataObject))];
  if (buckets.length > 0) fetchArgs.push(named('bucket', block([...new Set(buckets)].map(str))));

  // Time range: the query's own modifiers win, then the time picker, then the mapping default.
  const tr = st.tc.options.timeRange;
  const zone = m.defaults.timezone;
  if (!earliest && tr?.earliest !== undefined) earliest = { value: parseTimeModifier(tr.earliest, zone), span: st.span };
  if (!latest && tr?.latest !== undefined) latest = { value: parseTimeModifier(tr.latest, zone), span: st.span };
  if (!earliest && m.defaults.timeframe !== undefined) earliest = { value: parseTimeModifier(m.defaults.timeframe, zone), span: st.span };
  const from = earliest ? timeArg(st, 'earliest', earliest.value, earliest.span) : undefined;
  const to = latest ? timeArg(st, 'latest', latest.value, latest.span) : undefined;
  if (from) fetchArgs.push(named('from', from));
  if (to) fetchArgs.push(named('to', to));
  if (!earliest) st.tc.diags.reportOnce('SPL5001', st.span, st.index);

  st.emit({ name: 'fetch', args: fetchArgs });

  const exprs = [...rawFilters];
  for (const c of rest) {
    const e = lowerNode(c, st, false, undefined);
    if (e) exprs.push(e);
  }
  emitFilters(st, exprs);
}

/** A `search` stage after the first one. */
export function lowerLaterSearch(st: Stage, root: SNode | undefined): void {
  if (!root) return;
  const exprs: DqlExpr[] = [];
  const terms: string[] = [];
  for (const c of conjuncts(root)) {
    if (st.state.schema.kind !== 'events' && c.t === 'term') {
      terms.push(c.v);
      st.report('SPL3011', c.span, { detail: 'A free-text term after a transforming command is matched against all fields with the DQL search command.' });
      continue;
    }
    if (c.t === 'cmp' && (c.field === 'earliest' || c.field === 'latest')) {
      st.report('SPL2003', c.span, { detail: 'A time modifier in a later search stage has no DQL equivalent and was left out.' });
      continue;
    }
    const e = lowerNode(c, st, false, undefined);
    if (e) exprs.push(e);
  }
  emitFilters(st, exprs);
  for (const t of terms) st.emit(cmd('search', str(t)));
}

function lookupIndex<T>(map: ReadonlyMap<string, T>, name: string): T | undefined {
  const exact = map.get(name);
  if (exact) return exact;
  let best: { len: number; value: T } | undefined;
  for (const [pattern, value] of map) {
    if (!pattern.includes('*')) continue;
    if (wildcardMatch(pattern, name) && (!best || pattern.length > best.len)) best = { len: pattern.length, value };
  }
  return best?.value;
}

/** Glob match with `*` only, linear time. */
export function wildcardMatch(pattern: string, text: string): boolean {
  const parts = pattern.split('*');
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (parts.length === 1) return pattern === text;
  if (!text.startsWith(first) || text.length < first.length + last.length || !text.endsWith(last)) return false;
  let i = first.length;
  const end = text.length - last.length;
  for (let p = 1; p < parts.length - 1; p++) {
    const part = parts[p] as string;
    const at = text.indexOf(part, i);
    if (at === -1 || at + part.length > end) return false;
    i = at + part.length;
  }
  return true;
}

function timeArg(st: Stage, which: 'earliest' | 'latest', v: TimeValue, span: Span): DqlExpr | undefined {
  switch (v.kind) {
    case 'now':
      return undefined;
    case 'all':
      if (which === 'earliest') st.report('SPL3015', span, { detail: '"All time" has no DQL equivalent; choose the time range in Dynatrace.' });
      return undefined;
    case 'realtime':
      st.report('SPL2011', span, { detail: 'Real-time searches have no DQL equivalent; the time modifier was left out.' });
      return undefined;
    case 'invalid':
      st.report('SPL3015', span, { detail: v.detail });
      return undefined;
    case 'absolute':
      if (v.fromText) st.report('SPL3010', span, { detail: `The date was converted to UTC using the time zone "${st.mapping.defaults.timezone}".` });
      return str(v.iso);
    case 'relative':
      if (!v.exact) st.report('SPL3015', span, { detail: 'An offset after the snap unit was kept as an expression; check that Dynatrace accepts it.' });
      return time(v.dql);
  }
}
