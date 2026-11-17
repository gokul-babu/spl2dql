/**
 * Splunk Dashboard Studio definition (JSON) → DashboardModel. docs/spec/dashboards.md §3.
 */

import { MAX_BASE_CHAIN, MAX_DASHBOARD_INPUTS, MAX_INPUT } from '../limits.ts';
import { escapeText, rebuildMarkdown } from './markdown.ts';
import {
  DashboardError,
  type DashboardInput,
  type DashboardModel,
  type DashboardPanel,
  type DashboardSearch,
  type InputKind,
  type PanelKind,
} from './model.ts';
import { CHAIN_TOO_DEEP, JOINED_TOO_LONG, joinSearch, TOO_MANY_INPUTS } from './simple-xml.ts';

type Json = Record<string, unknown>;

/** A data source as resolved: the search it runs, a saved search it names, or why it was not read. */
interface Found {
  search?: DashboardSearch;
  savedSearch?: string;
  unreadable?: string;
}

const VIZ: ReadonlyMap<string, { kind: PanelKind; chart?: string }> = new Map([
  ['splunk.line', { kind: 'chart', chart: 'line' }],
  ['splunk.area', { kind: 'chart', chart: 'area' }],
  ['splunk.column', { kind: 'chart', chart: 'column' }],
  ['splunk.bar', { kind: 'chart', chart: 'bar' }],
  ['splunk.pie', { kind: 'chart', chart: 'pie' }],
  ['splunk.scatter', { kind: 'chart', chart: 'scatter' }],
  ['splunk.bubble', { kind: 'chart', chart: 'bubble' }],
  ['splunk.markergauge', { kind: 'chart', chart: 'markergauge' }],
  ['splunk.fillergauge', { kind: 'chart', chart: 'fillergauge' }],
  ['splunk.singlevalue', { kind: 'single' }],
  ['splunk.singlevalueicon', { kind: 'single' }],
  ['splunk.singlevalueradial', { kind: 'single' }],
  ['splunk.table', { kind: 'table' }],
  ['splunk.events', { kind: 'event' }],
  ['splunk.map', { kind: 'map' }],
  ['splunk.markdown', { kind: 'text' }],
]);

const INPUTS: ReadonlyMap<string, InputKind> = new Map([
  ['input.dropdown', 'dropdown'],
  ['input.multiselect', 'multiselect'],
  ['input.text', 'text'],
  ['input.number', 'text'],
  ['input.timerange', 'time'],
]);

/** Shapes, images and lines carry no data; they are counted, not converted. */
const DECORATION = /^splunk\.(rectangle|ellipse|image)$|^abslayout\./;

const MAX_PANELS = 2_000;
/** Tabs read from one dashboard. */
const MAX_TABS = 200;
/** Largest `position` value read, in pixels; larger ones are clamped to it. */
const MAX_POSITION = 100_000;

export function readStudio(definition: unknown, fallbackTitle?: string): DashboardModel {
  if (!isRecord(definition) || (!isRecord(definition.visualizations) && !isRecord(definition.dataSources))) {
    throw new DashboardError('This JSON is not a Dashboard Studio definition: it has no "visualizations" or "dataSources".');
  }
  const visualizations = record(definition.visualizations);
  const dataSources = record(definition.dataSources);
  const defaults = record(record(own(record(record(definition.defaults).dataSources), 'ds.search')).options);
  const defaultRange = record(defaults.queryParameters);
  const dropped: string[] = [];

  const resolve = (id: unknown, depth = 0): Found => {
    if (typeof id !== 'string') return {};
    if (depth > MAX_BASE_CHAIN) return { unreadable: CHAIN_TOO_DEEP };
    const ds = record(own(dataSources, id));
    const options = record(ds.options);
    if (ds.type === 'ds.savedSearch') return typeof options.ref === 'string' ? { savedSearch: options.ref } : {};
    const query = typeof options.query === 'string' ? options.query : undefined;
    const range = record(options.queryParameters);
    if (ds.type === 'ds.chain') {
      const parent = resolve(options.extend, depth + 1);
      if (!parent.search) return parent;
      if (parent.search.spl.length + (query?.length ?? 0) > MAX_INPUT) return { unreadable: JOINED_TOO_LONG };
      return { search: { ...parent.search, spl: joinSearch(parent.search.spl, query) } };
    }
    if (ds.type !== 'ds.search' || query === undefined) return {};
    const search: DashboardSearch = { spl: query.trim() };
    const earliest = text(range.earliest) ?? text(defaultRange.earliest);
    const latest = text(range.latest) ?? text(defaultRange.latest);
    if (earliest !== undefined) search.earliest = earliest;
    if (latest !== undefined) search.latest = latest;
    return { search };
  };

  const inputs: DashboardInput[] = [];
  for (const raw of Object.values(record(definition.inputs))) {
    if (inputs.length >= MAX_DASHBOARD_INPUTS) {
      dropped.push(TOO_MANY_INPUTS);
      break;
    }
    const input = record(raw);
    const options = record(input.options);
    // Values from the JSON are read with text(): String() of an object can throw.
    const inputType = text(input.type);
    const kind = inputType === undefined ? undefined : INPUTS.get(inputType);
    const token = text(options.token);
    if (!kind || token === undefined) {
      dropped.push(`An input of type "${inputType ?? typeof input.type}" was left out.`);
      continue;
    }
    const out: DashboardInput = { token, kind, choices: [] };
    const label = text(input.title);
    if (label !== undefined) out.label = label;
    if (kind === 'time') {
      const [earliest, latest] = (text(options.defaultValue) ?? '').split(',');
      if (earliest) out.earliest = earliest.trim();
      if (latest) out.latest = latest.trim();
      inputs.push(out);
      continue;
    }
    if (Array.isArray(options.items)) {
      for (const item of options.items) {
        const value = text(record(item).value);
        if (value !== undefined) out.choices.push({ label: text(record(item).label) ?? value, value });
      }
    } else if (typeof options.items === 'string') {
      // ">frame(label, value) | prepend(…) | objects()" names the result field holding the value.
      const frame = /frame\(\s*[A-Za-z_][\w.]*\s*,\s*([A-Za-z_][\w.]*)\s*\)/.exec(options.items);
      if (frame) out.valueField = frame[1] as string;
    }
    const populated = resolve(record(input.dataSources).primary);
    if (populated.search) out.search = populated.search;
    if (populated.unreadable !== undefined) dropped.push(`The search of the input "${token}" was not read. ${populated.unreadable}`);
    const def = options.defaultValue;
    if (typeof def === 'string' && def !== '') out.defaultValue = def;
    else if (Array.isArray(def) && def.length > 0) {
      const values = def.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map((v) => `${v}`);
      if (values.length > 0) out.defaultValue = values.join(',');
    }
    inputs.push(out);
  }

  // Layout: one structure, or one per tab.
  const layout = record(definition.layout);
  const structures: { label?: string; structure: unknown[]; canvas: number }[] = [];
  const definitions = record(layout.layoutDefinitions);
  const tabs = record(layout.tabs).items;
  if (Array.isArray(tabs) && Object.keys(definitions).length > 0) {
    // At most MAX_TABS tabs; a layout several tabs show is read once (ADR-029).
    if (tabs.length > MAX_TABS) dropped.push(`The dashboard has more than ${MAX_TABS} tabs; the rest were left out.`);
    const seen = new Set<string>();
    let repeated = 0;
    for (const tab of tabs.slice(0, MAX_TABS)) {
      const layoutId = text(record(tab).layoutId) ?? '';
      if (seen.has(layoutId)) {
        repeated++;
        continue;
      }
      seen.add(layoutId);
      const def = record(own(definitions, layoutId));
      const entry: { label?: string; structure: unknown[]; canvas: number } = {
        structure: Array.isArray(def.structure) ? def.structure : [],
        canvas: canvasWidth(def),
      };
      const label = text(record(tab).label);
      if (label !== undefined) entry.label = label;
      structures.push(entry);
    }
    if (repeated > 0) dropped.push(`${repeated} tab(s) show a layout an earlier tab already shows; it was converted once.`);
  } else {
    structures.push({ structure: Array.isArray(layout.structure) ? layout.structure : [], canvas: canvasWidth(layout) });
  }

  const panels: DashboardPanel[] = [];
  const placed = new Set<string>();
  let offsetY = 0;
  let decorations = 0;
  for (const s of structures) {
    let bottom = 0;
    if (s.label !== undefined && structures.length > 1) {
      // A tab heading is a tile too: it counts toward the panel limit.
      if (panels.length >= MAX_PANELS) throw new DashboardError(`The dashboard has more than ${MAX_PANELS} panels.`);
      panels.push({ kind: 'text', text: `## ${escapeText(s.label, 1000)}`, dropped: [], box: { x: 0, y: offsetY, w: s.canvas, h: 50, canvas: s.canvas } });
      offsetY += 50;
    }
    for (const raw of s.structure) {
      const block = record(raw);
      const id = text(block.item);
      if (id === undefined || block.type === 'input') continue;
      const viz = record(own(visualizations, id));
      const type = vizType(viz);
      placed.add(id);
      if (DECORATION.test(type)) {
        decorations++;
        continue;
      }
      if (panels.length >= MAX_PANELS) throw new DashboardError(`The dashboard has more than ${MAX_PANELS} panels.`);
      const panel = readViz(viz, type, resolve);
      const pos = record(block.position);
      // Clamped on read (ADR-029): a huge value must not turn into millions of grid rows.
      const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_POSITION) : fallback);
      const box = { x: num(pos.x, 0), y: num(pos.y, bottom) + offsetY, w: num(pos.w, s.canvas), h: num(pos.h, 300), canvas: s.canvas };
      panel.box = box;
      bottom = Math.max(bottom, box.y - offsetY + box.h);
      panels.push(panel);
    }
    offsetY += bottom;
  }
  // Visualizations that are defined but not placed are still worth converting.
  for (const [id, raw] of Object.entries(visualizations)) {
    if (placed.has(id)) continue;
    const viz = record(raw);
    const type = vizType(viz);
    if (DECORATION.test(type) || panels.length >= MAX_PANELS) continue;
    const panel = readViz(viz, type, resolve);
    panel.box = { x: 0, y: offsetY, w: 1200, h: 300, canvas: 1200 };
    offsetY += 300;
    panels.push(panel);
  }
  if (decorations > 0) dropped.push(`${decorations} decorative element(s) (shapes, images, plain text boxes) were left out.`);

  const model: DashboardModel = {
    format: 'dashboard-studio',
    title: text(definition.title) ?? fallbackTitle ?? 'Splunk dashboard',
    inputs,
    panels,
    dropped,
  };
  const description = text(definition.description);
  if (description !== undefined) model.description = description;
  return model;
}

function readViz(viz: Json, type: string, resolve: (id: unknown) => Found): DashboardPanel {
  const known = VIZ.get(type);
  const panel: DashboardPanel = { kind: known?.kind ?? 'custom', dropped: [] };
  const title = text(viz.title);
  if (title !== undefined) panel.title = title;
  const description = text(viz.description);
  if (description !== undefined) panel.description = description;
  if (known?.chart !== undefined) panel.chartType = known.chart;
  if (!known) panel.dropped.push(`It uses the visualization "${type}"; a table is shown instead.`);
  if (panel.kind === 'text') {
    // Splunk's own Markdown, rebuilt from an allow-list; never passed through (ADR-029).
    panel.text = rebuildMarkdown(text(record(viz.options).markdown) ?? '');
    return panel;
  }
  const found = resolve(record(viz.dataSources).primary);
  if (found.search) panel.search = found.search;
  if (found.savedSearch !== undefined) panel.savedSearch = found.savedSearch;
  if (found.unreadable !== undefined) panel.unreadable = found.unreadable;
  if (Array.isArray(viz.eventHandlers) && viz.eventHandlers.length > 0) panel.dropped.push('Its drilldown (what a click does) is not carried over.');
  return panel;
}

/** The visualization type; early Dashboard Studio versions wrote `viz.line` for `splunk.line`. */
function vizType(viz: Json): string {
  return (text(viz.type) ?? '').replace(/^viz\./, 'splunk.');
}

function canvasWidth(layout: Json): number {
  const w = record(layout.options).width;
  return typeof w === 'number' && w >= 100 && w <= 100_000 ? w : 1200;
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A property the JSON object really has (never one inherited from Object.prototype). */
function own(obj: Json, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function record(v: unknown): Json {
  return isRecord(v) ? v : {};
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
