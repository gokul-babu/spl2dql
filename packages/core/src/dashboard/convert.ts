/**
 * Splunk dashboard → Dynatrace dashboard document. docs/spec/dashboards.md.
 *
 * A panel becomes a live data tile only when its search translated completely. Otherwise the tile
 * is a text tile that keeps the Splunk search and says what is missing: a dashboard that shows a
 * wrong number is worse than one that shows a gap.
 */

import { MAX_DASHBOARD_DQL, MAX_DASHBOARD_SPL } from '../limits.ts';
import { expandedLength, MAX_INPUT, tooLarge, translate } from '../translate.ts';
import type { DashboardToken, MappingConfig, ResultShape, TranslateOptions, TranslateResult } from '../types.ts';
import { append } from '../util/array.ts';
import { uniqueName } from '../util/unique.ts';
import { codeBlock, escapeText } from './markdown.ts';
import { DashboardError, type DashboardInput, type DashboardModel, type DashboardPanel, type DashboardSearch } from './model.ts';
import { readSimpleXml } from './simple-xml.ts';
import { readStudio } from './studio.ts';
import { leftoverTokens } from './tokens.ts';
import { child, parseXml, XmlError } from './xml.ts';

export interface DashboardSource {
  /** File name, used for the title when the dashboard has none. */
  name: string;
  text: string;
}

export interface ConvertOptions {
  mapping?: MappingConfig;
  strict?: boolean;
  /** Saved searches by name, for panels that refer to one instead of carrying a search. */
  savedSearches?: ReadonlyMap<string, DashboardSearch>;
}

export type TileOutcome = 'live' | 'manual' | 'text';

export interface TileReport {
  /** Key of the tile in the dashboard document. */
  id: string;
  title: string;
  /** live: a data tile with DQL. manual: a text tile holding the Splunk search. text: a text panel. */
  outcome: TileOutcome;
  visualization?: string;
  spl?: string;
  result?: TranslateResult;
  /** What to check or do by hand, in plain words. */
  notes: string[];
}

export interface VariableReport {
  key: string;
  /** Splunk token it replaces, without dollar signs. */
  token: string;
  type: 'query' | 'csv' | 'text';
  notes: string[];
  result?: TranslateResult;
}

export interface DynatraceDashboard {
  name: string;
  type: 'dashboard';
  content: {
    version: number;
    variables: Record<string, unknown>[];
    tiles: Record<string, Record<string, unknown>>;
    layouts: Record<string, { x: number; y: number; w: number; h: number }>;
  };
}

export interface DashboardConversion {
  title: string;
  format: DashboardModel['format'];
  dashboard: DynatraceDashboard;
  tiles: TileReport[];
  variables: VariableReport[];
  /** Dashboard-level notes: features left out, inputs dropped. */
  notes: string[];
  counts: Record<TileOutcome, number>;
  /** Characters of SPL this conversion was charged (after token rewriting and macro expansion). */
  work: number;
}

/** Dashboard document version the Dynatrace reference describes (third_party/dynatrace-for-ai). */
const CONTENT_VERSION = 21;
const GRID = 24;
/** "Select all" default of a multi-select variable, as documented by Dynatrace. */
const SELECT_ALL = '3420b2ac-f1cf-4b24-b62d-61ba1ba8ed05*';
const MAX_SOURCE = 10 * 1024 * 1024;
/** Characters of one manual tile, of each code block in it, and of one text tile. */
const MAX_TILE = 12_000;
const MAX_CODE = 5_000;
const MAX_TEXT_TILE = 8_000;
/** The converter's own last line when a tile had to be cut. */
const CUT = 'The rest of this text did not fit in the tile.';
const TOKEN = /\$([A-Za-z_][A-Za-z0-9_.]*)(\|[A-Za-z]+)?\$/g;
const TOO_LARGE = 'The dashboard is too large to convert in one go, so this panel was not translated. Convert it on its own, or split the dashboard.';
const TOO_LARGE_INPUT = 'The dashboard is too large to convert in one go, so the search that fills this input was not translated.';
/** Tokens Splunk fills in from a click, a search result or the environment: not inputs. */
const RUNTIME_TOKEN = /^(env|click|row|result|job|trellis)[.:]|^(earliest|latest)$/;

/** Reads a Simple XML file or a Dashboard Studio definition (JSON, or JSON inside `<definition>`). */
export function readDashboard(source: DashboardSource): DashboardModel {
  if (source.text.length > MAX_SOURCE) throw new DashboardError(`${source.name} is larger than 10 MB.`);
  const text = source.text.replace(/^\uFEFF/, '').trim();
  const fallback = source.name.replace(/^.*[\\/]/, '').replace(/\.(xml|json)$/i, '');
  if (text.startsWith('{')) return withTitle(readStudio(parseJson(text, source.name)), fallback);
  if (!text.startsWith('<')) throw new DashboardError(`${source.name} is neither XML nor JSON.`);
  let root: ReturnType<typeof parseXml>;
  try {
    root = parseXml(text);
  } catch (e) {
    if (e instanceof XmlError) throw new DashboardError(`${source.name}: ${e.message}`);
    throw e;
  }
  const definition = child(root, 'definition');
  if (definition?.text.trim().startsWith('{')) {
    const model = readStudio(parseJson(definition.text, source.name), child(root, 'label')?.text || undefined);
    return withTitle(model, fallback);
  }
  return withTitle(readSimpleXml(root), fallback);
}

function withTitle(model: DashboardModel, fallback: string): DashboardModel {
  if (model.title === 'Splunk dashboard' && fallback !== '') model.title = fallback;
  return model;
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DashboardError(`${name}: the dashboard definition is not valid JSON.`);
  }
}

export function convertDashboard(model: DashboardModel, options: ConvertOptions = {}): DashboardConversion {
  const notes = [...model.dropped];
  const base: TranslateOptions = {};
  if (options.mapping) base.mapping = options.mapping;
  if (options.strict) base.strict = true;

  // ---- tokens → variables -------------------------------------------------------------------
  const tokens = new Map<string, DashboardToken>();
  const keys = new Set<string>();
  const filterFields = new Map<string, string>();
  const declared: { input: DashboardInput; key: string }[] = [];
  for (const input of model.inputs) {
    if (input.kind === 'time') {
      const names = input.token === '' ? ['earliest', 'latest'] : [input.token, `${input.token}.earliest`, `${input.token}.latest`];
      for (const n of names) tokens.set(n, { variable: '', kind: 'time' });
      continue;
    }
    if (tokens.has(input.token)) continue;
    const key = variableKey(input.token, keys);
    tokens.set(input.token, { variable: key, kind: tokenKind(input) });
    if (input.filterField !== undefined) filterFields.set(input.token, input.filterField);
    declared.push({ input, key });
  }
  // Tokens used in a search but set elsewhere in Splunk (a drilldown, <init>, a script). Only the
  // searches within the dashboard's budget are read; the others are not translated either.
  const undeclared: { token: string; key: string }[] = [];
  const searches = [...model.panels.map((p) => p.search?.spl), ...model.inputs.map((i) => i.search?.spl)];
  let scanned = 0;
  for (const spl of searches) {
    if (spl === undefined) continue;
    scanned += spl.length;
    if (scanned > MAX_DASHBOARD_SPL) break;
    for (const m of spl.matchAll(TOKEN)) {
      const name = (m[1] as string).replace(/^form\./, '');
      if (tokens.has(name) || RUNTIME_TOKEN.test(name)) continue;
      const key = variableKey(name, keys);
      tokens.set(name, { variable: key, kind: 'text' });
      undeclared.push({ token: name, key });
    }
  }

  // The dashboard's budget (ADR-029): SPL translated and DQL kept, panels first, then inputs. Once
  // a search does not fit, no later one is translated, so the result does not depend on sizes.
  let splLeft = MAX_DASHBOARD_SPL;
  let dqlLeft = MAX_DASHBOARD_DQL;
  let exhausted = false;
  // A search past the budget is not even looked at: reading a search built on a shared base copies
  // the whole base, once per panel.
  const run = (search: DashboardSearch, extra = ''): TranslateResult | 'blank' | undefined => {
    // Charged for the work (ADR-029): the length after token rewriting, computed before the text
    // is built; then the length after macro expansion, expanded no further than the budget allows.
    // A search that cannot fit even as written is not read at all (reading a search built on a
    // shared base copies the whole base, once per panel).
    if (exhausted || search.spl.length + extra.length > splLeft) {
      exhausted = true;
      return undefined;
    }
    const prepared = preparedLength(search.spl, filterFields) + extra.length;
    if (prepared > splLeft) {
      exhausted = true;
      return undefined;
    }
    if (prepared > MAX_INPUT) {
      splLeft -= MAX_INPUT;
      return tooLarge(`The search is longer than ${MAX_INPUT} characters once its tokens are filled in.`);
    }
    if (search.spl.trim() === '') return 'blank';
    const opts: TranslateOptions = { ...base, tokens };
    const range: { earliest?: string; latest?: string } = {};
    // A literal range is the panel's own; a token is the time picker, which Dynatrace applies itself.
    if (search.earliest !== undefined && !search.earliest.includes('$')) range.earliest = search.earliest;
    if (search.latest !== undefined && !search.latest.includes('$')) range.latest = search.latest;
    if (range.earliest !== undefined || range.latest !== undefined) opts.timeRange = range;
    const text = prepareSpl(search.spl, filterFields) + extra;
    const expanded = expandedLength(text, opts, Math.min(splLeft, MAX_INPUT));
    if (expanded === undefined && splLeft < MAX_INPUT) {
      exhausted = true;
      return undefined;
    }
    splLeft -= expanded ?? MAX_INPUT;
    const result = expanded === undefined ? tooLarge(`Macro expansion makes the search longer than ${MAX_INPUT} characters.`) : translate(text, opts);
    // A translation that ends in "too large" is charged the full input cap.
    if (expanded !== undefined && result.diagnostics.some((d) => d.code === 'SPL1006')) splLeft = Math.max(0, splLeft - (MAX_INPUT - expanded));
    if (result.dql.length > dqlLeft) {
      exhausted = true;
      return undefined;
    }
    dqlLeft -= result.dql.length;
    return result;
  };

  // ---- tiles --------------------------------------------------------------------------------
  const tiles: TileReport[] = [];
  const documents: Record<string, unknown>[] = [];
  const sizes: { panel?: DashboardPanel; height: number }[] = [];
  const used = new Set<string>();
  const add = (report: Omit<TileReport, 'id'>, tile: Record<string, unknown>, panel: DashboardPanel | undefined, height: number): void => {
    tiles.push({ ...report, id: String(tiles.length) });
    documents.push(tile);
    sizes.push(panel ? { panel, height } : { height });
  };

  if (model.description !== undefined) {
    add(
      { title: model.title, outcome: 'text', notes: [] },
      // Splunk does not render a description as Markdown: it is plain text here too (ADR-029).
      { type: 'markdown', content: escapeText(model.description, 4000) },
      undefined,
      model.description.length > 160 ? 2 : 1,
    );
  }

  for (const panel of model.panels) {
    const title = panel.title ?? '';
    const panelNotes = [...panel.dropped];
    if (panel.kind === 'text') {
      // panel.text is Markdown the reader already made safe; a bare title is plain text.
      const content = panel.text === undefined || panel.text === '' ? escapeText(title, MAX_TEXT_TILE) : panel.text;
      if (content === '') continue;
      add(
        { title: title || firstLine(content), outcome: 'text', notes: panelNotes },
        { type: 'markdown', content: clipLines(content, MAX_TEXT_TILE) },
        panel,
        textHeight(content),
      );
      continue;
    }
    let search = panel.search;
    if (!search && panel.savedSearch !== undefined) {
      search = options.savedSearches?.get(panel.savedSearch);
      if (!search) {
        const why = `It runs the saved search "${panel.savedSearch}", which is not in the files given. Translate that search and paste its DQL here.`;
        add({ title, outcome: 'manual', notes: [why, ...panelNotes] }, manualTile(title, [why], undefined, undefined), panel, 4);
        continue;
      }
    }
    if (panel.unreadable !== undefined) {
      const why = panel.unreadable;
      add({ title, outcome: 'manual', notes: [why, ...panelNotes] }, manualTile(title, [why], undefined, undefined), panel, 4);
      continue;
    }
    if (!search || search.spl === '') {
      const why = 'The panel has no search.';
      add({ title, outcome: 'manual', notes: [why, ...panelNotes] }, manualTile(title, [why], undefined, undefined), panel, 3);
      continue;
    }
    const result = run(search);
    if (result === 'blank') {
      const why = 'The panel has no search.';
      add({ title, outcome: 'manual', notes: [why, ...panelNotes] }, manualTile(title, [why], undefined, undefined), panel, 3);
      continue;
    }
    if (!result) {
      // Past the budget: neither the search nor a result is kept, so one large base search shared
      // by many panels does not fill memory once per panel.
      add({ title, outcome: 'manual', notes: [TOO_LARGE, ...panelNotes] }, manualTile(title, [TOO_LARGE], undefined, undefined), panel, 4);
      continue;
    }
    const complete = result.confidence === 'high' || result.confidence === 'review';
    if (!complete) {
      const why = blockingReasons(result);
      add(
        { title, outcome: 'manual', spl: search.spl, result, notes: [...unique(why), ...panelNotes] },
        manualTile(title, unique(why), search.spl, result.dql),
        panel,
        7,
      );
      continue;
    }
    const viz = chooseVisualization(panel, result.shape);
    if (viz.note !== undefined) panelNotes.push(viz.note);
    for (const v of result.variables ?? []) used.add(v);
    const check = result.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.message);
    const tile: Record<string, unknown> = {
      type: 'data',
      title,
      query: result.dql,
      visualization: viz.name,
      visualizationSettings: {},
      querySettings: {},
    };
    if (panel.description !== undefined) tile.description = clip(panel.description, 1000);
    add({ title, outcome: 'live', visualization: viz.name, spl: search.spl, result, notes: [...unique(check), ...panelNotes] }, tile, panel, tileHeight(panel));
  }

  // ---- variables ----------------------------------------------------------------------------
  const variables: VariableReport[] = [];
  const definitions: Record<string, unknown>[] = [];
  const pending: { report: VariableReport; definition: Record<string, unknown>; needs: string[]; input: boolean }[] = [];
  for (const { input, key } of declared) {
    const kind = (tokens.get(input.token) as DashboardToken).kind;
    const report: VariableReport = { key, token: input.token, type: 'text', notes: [] };
    const definition: Record<string, unknown> = { key, visible: true, editable: true };
    const needs: string[] = [];
    const all = input.defaultValue === '*' || input.choices.some((c) => c.value === '*');
    const values = input.choices.map((c) => c.value).filter((v) => v !== '*' && v !== '');
    let populated: TranslateResult | undefined;
    let oneField = false;
    if (input.search) {
      const first = run(input.search);
      populated = first === 'blank' ? undefined : first;
      oneField = populated?.shape?.kind === 'table' && populated.shape.fields.length === 1;
      if (populated && input.valueField !== undefined && !oneField) {
        // Keep only the value field — unless the search does not produce a field of that name.
        const second = run(input.search, ` | table ${quoteField(input.valueField)}`);
        const narrowed = second === 'blank' ? undefined : second;
        const known = populated.shape?.kind !== 'table' || narrowed?.shape?.fields.every((f) => populated?.shape?.fields.includes(f));
        if (narrowed && known) {
          populated = narrowed;
          oneField = true;
        }
      }
      if (populated) report.result = populated;
      else if (first === undefined) report.notes.push(TOO_LARGE_INPUT);
    }
    if (populated && (populated.confidence === 'high' || populated.confidence === 'review')) {
      report.type = 'query';
      Object.assign(definition, { version: 2, type: 'query', input: populated.dql, multiple: kind === 'multiple' });
      append(needs, populated.variables ?? []);
      if (!oneField) report.notes.push('A variable query must return exactly one field; add "| fields <the value field>" to this one.');
      for (const d of populated.diagnostics) if (d.severity !== 'info') report.notes.push(d.message);
    } else if (values.length > 0 && kind !== 'text') {
      report.type = 'csv';
      Object.assign(definition, { version: 1, type: 'csv', input: values.join(','), multiple: kind === 'multiple' });
      if (values.some((v) => v.includes(','))) report.notes.push('A choice contains a comma, which separates values in a Dynatrace list variable.');
      if (input.choices.some((c) => c.label !== c.value && c.value !== '*'))
        report.notes.push('Splunk showed labels for the choices; the variable lists the values themselves.');
      if (input.search) report.notes.push('The search that filled this input could not be translated; only its fixed choices were kept.');
    } else {
      report.type = 'text';
      Object.assign(definition, { version: 1, type: 'text' });
      if (input.search) report.notes.push('The search that filled this input could not be translated; type the value instead.');
      else if (kind !== 'text') report.notes.push('The input had no choices to carry over; type the value instead.');
    }
    if (report.type === 'text') {
      definition.defaultValue = input.defaultValue ?? '';
    } else if (kind === 'multiple') {
      definition.defaultValue = SELECT_ALL;
      if (all && input.kind !== 'multiselect' && input.kind !== 'checkbox') {
        report.notes.push('The "All" choice became a multi-select variable with every value selected.');
      }
    } else if (input.defaultValue !== undefined && input.defaultValue !== '*') {
      definition.defaultValue = input.defaultValue;
    }
    pending.push({ report, definition, needs: unique(needs), input: true });
  }
  for (const u of undeclared) {
    const report: VariableReport = {
      key: u.key,
      token: u.token,
      type: 'text',
      notes: ['Splunk sets this token from a click or a script, not from an input; here it is a text variable to fill in.'],
    };
    pending.push({ report, definition: { key: u.key, version: 1, type: 'text', visible: true, editable: true, defaultValue: '' }, needs: [], input: false });
  }
  // A variable is kept when a live tile uses it, or a kept variable's query does.
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of pending) {
      if (!used.has(p.report.key)) continue;
      for (const n of p.needs) {
        if (!used.has(n)) {
          used.add(n);
          changed = true;
        }
      }
    }
  }
  // How each variable is used: `$v:noquote` (the value is written as it is, a number) and
  // `$v:backtick` (the value names a field). A default or a fixed choice that would not be safe in
  // every such use is left out (ADR-029).
  const uses = new Map<string, Set<string>>();
  const queries: string[] = [];
  for (const d of documents) if (typeof d.query === 'string') queries.push(d.query);
  for (const p of pending)
    if (used.has(p.report.key) && typeof p.definition.input === 'string' && p.definition.type === 'query') queries.push(p.definition.input);
  for (const q of queries) {
    for (const m of q.matchAll(/\$([A-Za-z0-9_]+):(noquote|backtick|triplequote)/g)) {
      const set = uses.get(m[1] as string) ?? new Set<string>();
      set.add(m[2] as string);
      uses.set(m[1] as string, set);
    }
  }
  for (const p of pending) {
    if (used.has(p.report.key)) {
      keepSafeValues(p.report, p.definition, uses.get(p.report.key));
      variables.push(p.report);
      definitions.push(p.definition);
    } else if (p.input) {
      notes.push(`The input "$${p.report.token}$" is not used by any converted tile, so it has no variable.`);
    }
  }
  if (model.inputs.some((i) => i.kind === 'time')) notes.push('The time input is the time frame picker of the Dynatrace dashboard.');

  // ---- document -----------------------------------------------------------------------------
  const layouts = layout(sizes);
  const dashboard: DynatraceDashboard = {
    name: clip(model.title, 200),
    type: 'dashboard',
    content: {
      version: CONTENT_VERSION,
      variables: definitions,
      tiles: Object.fromEntries(documents.map((t, i) => [String(i), t as Record<string, unknown>])),
      layouts: Object.fromEntries(layouts.map((l, i) => [String(i), l])),
    },
  };
  const counts: Record<TileOutcome, number> = { live: 0, manual: 0, text: 0 };
  for (const t of tiles) counts[t.outcome]++;
  return { title: model.title, format: model.format, dashboard, tiles, variables, notes: unique(notes), counts, work: MAX_DASHBOARD_SPL - splLeft };
}

/** One call for a file: read it, then convert it. */
export function convertDashboardSource(source: DashboardSource, options: ConvertOptions = {}): DashboardConversion {
  return convertDashboard(readDashboard(source), options);
}

// ---------------------------------------------------------------------------------------------------

const NUMBER = /^-?\d+(\.\d+)?$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Keeps a variable's default and fixed choices only when each is safe for every way the dashboard's
 * queries use the variable: a number where it is written as it is (`:noquote`), a plain field name
 * where it names a field (`:backtick`), without `"""` where it sits inside triple quotes (`:triplequote`).
 */
function keepSafeValues(report: VariableReport, definition: Record<string, unknown>, how: ReadonlySet<string> | undefined): void {
  if (!how || how.size === 0) return;
  const safe = (v: string): boolean =>
    (!how.has('noquote') || NUMBER.test(v)) && (!how.has('backtick') || FIELD_NAME.test(v)) && (!how.has('triplequote') || !v.includes('"""'));
  const rule = how.has('noquote')
    ? 'a number, because a query uses the value as a number'
    : how.has('backtick')
      ? 'a plain field name, because a query uses the value as a field name'
      : 'free of three double quotes in a row, because a query uses the value inside triple quotes';
  if (definition.type === 'csv' && typeof definition.input === 'string') {
    const all = definition.input.split(',');
    const kept = all.filter(safe);
    if (kept.length < all.length) {
      report.notes.push(`${all.length - kept.length} choice(s) were left out: each must be ${rule}.`);
      if (kept.length > 0) definition.input = kept.join(',');
      else {
        report.type = 'text';
        for (const k of ['input', 'multiple']) delete definition[k];
        Object.assign(definition, { version: 1, type: 'text', defaultValue: '' });
      }
    }
  }
  const value = definition.defaultValue;
  if (typeof value === 'string' && value !== '' && value !== SELECT_ALL && !safe(value)) {
    if (definition.type === 'text') definition.defaultValue = '';
    else delete definition.defaultValue;
    report.notes.push(`The default value was left out: it must be ${rule}.`);
  }
}

/** Why a search did not translate completely: its errors, and the notes of the stages left out. */
function blockingReasons(result: TranslateResult): string[] {
  const untranslated = new Set(result.stages.filter((s) => s.status === 'untranslated').map((s) => s.index));
  const reasons = result.diagnostics.filter((d) => d.severity === 'error' || (d.severity !== 'info' && untranslated.has(d.stageIndex))).map((d) => d.message);
  return reasons.length > 0 ? unique(reasons) : ['The search could not be translated.'];
}

function tokenKind(input: DashboardInput): DashboardToken['kind'] {
  if (input.kind === 'text') return 'text';
  if (input.kind === 'multiselect' || input.kind === 'checkbox') return 'multiple';
  // A dropdown with an "All" (*) choice has no single-value equivalent: every value selected is.
  if (input.defaultValue === '*' || input.choices.some((c) => c.value === '*')) return 'multiple';
  return 'single';
}

/** A Dynatrace variable key from a token name: letters, digits and underscores, unique. */
function variableKey(token: string, taken: Set<string>): string {
  let key = token.replace(/^form\./, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(key)) key = `v_${key}`;
  key = key.slice(0, 60);
  return uniqueName(key, taken, (n) => `${key}_${n}`);
}

/**
 * Normalises token spelling before translation: `$tok|s$` is the quoted value, `$form.tok$` is
 * `$tok$`, and a token that already holds `field="value"` is written as a condition on that field.
 */
function prepareSpl(spl: string, filterFields: ReadonlyMap<string, string>): string {
  return spl.replace(TOKEN, (_whole, rawName: string, filter: string | undefined) => {
    const name = rawName.replace(/^form\./, '');
    const fieldName = filterFields.get(name);
    if (fieldName !== undefined) return `${fieldName}="$${name}$"`;
    return filter === '|s' ? `"$${name}$"` : `$${name}$`;
  });
}

/** Length of `prepareSpl(spl, filterFields)`, computed without building it. */
function preparedLength(spl: string, filterFields: ReadonlyMap<string, string>): number {
  let length = spl.length;
  for (const m of spl.matchAll(TOKEN)) {
    const name = (m[1] as string).replace(/^form\./, '');
    const fieldName = filterFields.get(name);
    const written = fieldName !== undefined ? fieldName.length + name.length + 5 : m[2] === '|s' ? name.length + 4 : name.length + 2;
    length += written - m[0].length;
  }
  return length;
}

function quoteField(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

/** The Dynatrace visualization for a Splunk panel, given what the query returns. */
export function chooseVisualization(panel: DashboardPanel, shape: ResultShape | undefined): { name: string; note?: string } {
  const timeAxis = shape?.kind === 'series' || (shape?.kind === 'table' && shape.fields.includes('timestamp'));
  switch (panel.kind) {
    case 'single':
      return { name: 'singleValue' };
    case 'table':
    case 'event':
      return { name: 'table' };
    case 'map':
      return { name: 'table', note: 'A Splunk map has no direct counterpart here; the result is shown as a table.' };
    case 'custom':
      return { name: 'table' };
    case 'chart': {
      const type = panel.chartType ?? 'column';
      if (type === 'pie') return timeAxis ? { name: 'lineChart', note: 'A pie chart cannot show a time series; a line chart is used.' } : { name: 'pieChart' };
      if (/gauge$/.test(type)) return { name: 'gauge' };
      if (type === 'scatter') return { name: 'scatterplot' };
      if (type === 'bubble') return { name: 'table', note: 'A bubble chart has no direct counterpart here; the result is shown as a table.' };
      if (timeAxis) return { name: type === 'area' ? 'areaChart' : type === 'line' ? 'lineChart' : 'barChart' };
      if (type === 'line' || type === 'area') {
        return { name: 'categoricalBarChart', note: `A ${type} chart needs a time axis in Dynatrace; this result has none, so bars per category are used.` };
      }
      return { name: 'categoricalBarChart' };
    }
    default:
      return { name: 'table' };
  }
}

/** A text tile for a panel that needs manual work: what is missing, the Splunk search, the partial DQL. */
function manualTile(title: string, reasons: string[], spl: string | undefined, dql: string | undefined): Record<string, unknown> {
  const blocks: string[] = [];
  const heading = escapeText(title, 300);
  if (heading !== '') blocks.push(`### ${heading}`);
  blocks.push('**Not converted yet.** This Splunk panel needs manual work:');
  blocks.push(
    reasons
      .slice(0, 8)
      .map((r) => `- ${escapeText(r, 500)}`)
      .join('\n'),
  );
  // Only the start of a long text can fit in the tile; it is cut before the block is built. The
  // line before each block is the converter's own, so no list can run on into the code.
  if (spl !== undefined) blocks.push('Splunk search:', codeBlock(clip(spl, MAX_CODE)));
  if (dql !== undefined && dql.trim() !== '') blocks.push('DQL so far:', codeBlock(clip(dql, MAX_CODE)));
  return { type: 'markdown', content: clipLines(blocks.join('\n\n'), MAX_TILE) };
}

function tileHeight(panel: DashboardPanel): number {
  if (panel.kind === 'single') return 3;
  if (panel.kind === 'chart') return 6;
  return 7;
}

function textHeight(content: string): number {
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 90)), 0);
  return Math.min(8, Math.max(2, wrapped + 1));
}

/**
 * Places tiles on Dynatrace's 24-column grid. Simple XML rows share the width equally; Dashboard
 * Studio boxes are scaled from pixels, then moved down until nothing overlaps.
 */
function layout(sizes: { panel?: DashboardPanel; height: number }[]): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const boxes = sizes.map((s) => s.panel?.box).filter((b) => b !== undefined);
  if (boxes.length > 0) {
    // The canvas margins are not part of the layout: scale the area the panels really cover.
    // Loops, not Math.min(...list): a spread of 100,000 boxes would exceed the call stack.
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (const b of boxes) {
      left = Math.min(left, b.x);
      right = Math.max(right, b.x + b.w);
    }
    const unit = Math.max(1, right - left) / GRID;
    let top = 0;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const s of sizes) {
      const box = s.panel?.box;
      if (!box) {
        const rect = { x: 0, y: top, w: GRID, h: s.height };
        top += s.height;
        out.push(rect);
        placed.push(rect);
        continue;
      }
      const x = Math.min(GRID - 1, Math.max(0, Math.round((box.x - left) / unit)));
      const end = Math.min(GRID, Math.max(x + 2, Math.round((box.x + box.w - left) / unit)));
      const h = s.panel?.kind === 'text' ? Math.max(1, Math.round(box.h / 50)) : Math.max(3, Math.round(box.h / 50));
      const rect = { x, y: top + Math.round(box.y / 50), w: end - x, h };
      rect.y = firstFreeRow(rect, placed);
      out.push(rect);
      placed.push(rect);
    }
    // Close the vertical gaps rounding leaves: move each tile up until it meets another. Tiles are
    // taken from the top; nothing overlaps, so a tile stops at the lowest bottom edge already placed
    // in its columns (a skyline per column), which is where moving up one row at a time would stop.
    const skyline = new Array<number>(GRID).fill(0);
    for (const rect of [...placed].sort((a, b) => a.y - b.y)) {
      let floor = 0;
      for (let c = rect.x; c < rect.x + rect.w; c++) floor = Math.max(floor, skyline[c] ?? 0);
      rect.y = Math.min(rect.y, floor);
      for (let c = rect.x; c < rect.x + rect.w; c++) skyline[c] = Math.max(skyline[c] ?? 0, rect.y + rect.h);
    }
    return out;
  }
  // Rows: each row is as tall as its tallest column; panels stacked in one column share it.
  const rowHeights = new Map<number, number>();
  const columnHeights = new Map<string, number>();
  for (const s of sizes) {
    const r = s.panel?.row;
    if (!r) continue;
    const key = `${r.index}:${r.column}`;
    const h = (columnHeights.get(key) ?? 0) + s.height;
    columnHeights.set(key, h);
    rowHeights.set(r.index, Math.max(rowHeights.get(r.index) ?? 0, h));
  }
  let y = 0;
  const rowTop = new Map<number, number>();
  const stackTop = new Map<string, number>();
  let leading = 0;
  for (const s of sizes) if (!s.panel?.row) leading += s.height;
  let cursor = 0;
  for (const index of [...rowHeights.keys()].sort((a, b) => a - b)) {
    rowTop.set(index, leading + y);
    y += rowHeights.get(index) ?? 0;
  }
  for (const s of sizes) {
    const r = s.panel?.row;
    if (!r) {
      out.push({ x: 0, y: cursor, w: GRID, h: s.height });
      cursor += s.height;
      continue;
    }
    const span = Math.max(1, r.span);
    const x = Math.floor((r.column * GRID) / span);
    const w = Math.max(1, Math.floor(((r.column + 1) * GRID) / span) - x);
    const key = `${r.index}:${r.column}`;
    const offset = stackTop.get(key) ?? 0;
    stackTop.set(key, offset + s.height);
    // The last tile of a column fills what is left of the row, so a row has one bottom edge.
    const isLast = offset + s.height === (columnHeights.get(key) ?? 0);
    const h = isLast ? (rowHeights.get(r.index) ?? s.height) - offset : s.height;
    out.push({ x, y: (rowTop.get(r.index) ?? 0) + offset, w, h });
  }
  return out;
}

/**
 * The first row at or below `rect.y` where `rect` overlaps no placed tile: the same row that moving
 * down one row at a time would reach, found by jumping past the tiles in its columns in top order.
 */
function firstFreeRow(rect: { x: number; y: number; w: number; h: number }, placed: readonly { x: number; y: number; w: number; h: number }[]): number {
  const inColumns = placed.filter((p) => p.x < rect.x + rect.w && rect.x < p.x + p.w && p.y + p.h > rect.y).sort((a, b) => a.y - b.y);
  let y = rect.y;
  for (const p of inColumns) {
    if (p.y >= y + rect.h) break;
    if (p.y + p.h > y) y = p.y + p.h;
  }
  return y;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Generated Markdown cut at a line end, never inside a line (ADR-029): lines are kept while they
 * fit; the first that does not, and everything after it, is dropped, and one closing line of the
 * converter's own says so. Every line the converter writes is complete in itself.
 */
function clipLines(markdown: string, max: number): string {
  if (markdown.length <= max) return markdown;
  const room = max - CUT.length - 2;
  const lines = markdown.split('\n');
  let length = -1;
  let kept = 0;
  for (const line of lines) {
    if (length + 1 + line.length > room) break;
    length += 1 + line.length;
    kept++;
  }
  return [...lines.slice(0, kept), '', CUT].join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(text: string): string {
  return clip((text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^#+\s*/, ''), 80);
}

/** Tokens a converted query still spells as `$name$` (exported for the report). */
export function unresolvedTokens(result: TranslateResult): string[] {
  return leftoverTokens(result.dql);
}
