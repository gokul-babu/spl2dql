/**
 * Splunk Simple XML (`<dashboard>` / `<form>`) → DashboardModel. docs/spec/dashboards.md §2.
 */

import { MAX_BASE_CHAIN, MAX_DASHBOARD_INPUTS, MAX_INPUT } from '../limits.ts';
import { escapeText, isWebTarget, sealLine } from './markdown.ts';
import {
  DashboardError,
  type DashboardInput,
  type DashboardModel,
  type DashboardPanel,
  type DashboardSearch,
  type InputKind,
  type PanelKind,
} from './model.ts';
import { child, childrenNamed, childText, deepText, type XmlNode } from './xml.ts';

const PANEL_KINDS: ReadonlyMap<string, PanelKind> = new Map([
  ['chart', 'chart'],
  ['table', 'table'],
  ['single', 'single'],
  ['event', 'event'],
  ['list', 'event'],
  ['map', 'map'],
  ['html', 'text'],
  ['viz', 'custom'],
]);

const INPUT_KINDS: ReadonlyMap<string, InputKind> = new Map([
  ['dropdown', 'dropdown'],
  ['radio', 'radio'],
  ['multiselect', 'multiselect'],
  ['checkbox', 'checkbox'],
  ['text', 'text'],
  ['time', 'time'],
  ['link', 'link'],
]);

const MAX_PANELS = 2_000;
/** Longest field name read from an input's `<prefix>` / `<valuePrefix>`. */
const MAX_FILTER_FIELD = 200;

/** A search as read: what it runs, a saved search it names, or why it could not be read. */
interface FoundSearch {
  search?: DashboardSearch;
  savedSearch?: string;
  unreadable?: string;
}

/** A base search by id, with how many bases it is built from. */
interface BaseSearch {
  found: FoundSearch;
  depth: number;
}

export const CHAIN_TOO_DEEP = `It continues a chain of more than ${MAX_BASE_CHAIN} base searches, which was not followed.`;
export const JOINED_TOO_LONG = `With its base search it is longer than ${MAX_INPUT} characters, which is more than one search can be.`;
export const TOO_MANY_INPUTS = `The dashboard has more than ${MAX_DASHBOARD_INPUTS} inputs; the rest were left out.`;

export function readSimpleXml(root: XmlNode): DashboardModel {
  if (root.name !== 'dashboard' && root.name !== 'form') {
    throw new DashboardError(`The root element is <${root.name}>; a Splunk dashboard starts with <dashboard> or <form>.`);
  }
  const dropped: string[] = [];
  const base = new Map<string, BaseSearch>();
  for (const s of childrenNamed(root, 'search')) {
    const id = s.attrs.get('id');
    const parent = base.get(s.attrs.get('base') ?? '');
    const found = readSearch(s, base);
    if (id !== undefined && (found.search || found.unreadable !== undefined)) base.set(id, { found, depth: (parent?.depth ?? 0) + 1 });
  }

  const inputs: DashboardInput[] = [];
  const addInputs = (parent: XmlNode): void => {
    for (const node of childrenNamed(parent, 'input')) {
      if (inputs.length >= MAX_DASHBOARD_INPUTS) {
        if (!dropped.includes(TOO_MANY_INPUTS)) dropped.push(TOO_MANY_INPUTS);
        return;
      }
      const input = readInput(node, base, dropped);
      if (input) inputs.push(input);
      else dropped.push(`An input of type "${node.attrs.get('type') ?? 'text'}" without a token.`);
    }
  };
  for (const fs of childrenNamed(root, 'fieldset')) addInputs(fs);

  const panels: DashboardPanel[] = [];
  let rowIndex = 0;
  for (const row of childrenNamed(root, 'row')) {
    // Old dashboards put the visualizations directly in the row, without a <panel> around them.
    const groups = row.children.filter((c) => c.name === 'panel' || PANEL_KINDS.has(c.name)).map((c) => (c.name === 'panel' ? c : wrap(c)));
    const rowHidden = row.attrs.has('depends') || row.attrs.has('rejects');
    groups.forEach((panel, column) => {
      addInputs(panel);
      const panelTitle = childText(panel, 'title');
      if (panel.attrs.has('ref')) dropped.push(`A prebuilt panel (ref="${panel.attrs.get('ref')}") is defined outside this file.`);
      let stack = 0;
      for (const el of panel.children) {
        const kind = PANEL_KINDS.get(el.name);
        if (!kind) continue;
        if (panels.length >= MAX_PANELS) throw new DashboardError(`The dashboard has more than ${MAX_PANELS} panels.`);
        const p = readPanel(el, kind, base);
        if (p.title === undefined && panelTitle !== undefined && stack === 0) p.title = panelTitle;
        if (rowHidden || panel.attrs.has('depends') || panel.attrs.has('rejects') || el.attrs.has('depends') || el.attrs.has('rejects')) {
          p.dropped.push('It is shown or hidden by a token (depends/rejects); the tile is always shown.');
        }
        p.row = { index: rowIndex, column, span: groups.length, stack };
        panels.push(p);
        stack++;
      }
    });
    rowIndex++;
  }

  if (root.attrs.has('script')) dropped.push('Custom JavaScript (script=…) is not carried over.');
  if (root.attrs.has('stylesheet')) dropped.push('A custom stylesheet is not carried over.');
  if (root.attrs.has('refresh')) dropped.push('Automatic refresh is set in the Dynatrace dashboard itself.');
  if (child(root, 'init')) dropped.push('Tokens set when the dashboard opens (<init>) are not carried over.');

  const model: DashboardModel = {
    format: 'simple-xml',
    title: childText(root, 'label') ?? 'Splunk dashboard',
    inputs,
    panels,
    dropped,
  };
  const description = childText(root, 'description');
  if (description !== undefined) model.description = description;
  return model;
}

function wrap(el: XmlNode): XmlNode {
  return { name: 'panel', attrs: new Map(), children: [el], text: '', content: [el] };
}

/**
 * `<search>` with `<query>`, optionally continuing a base search (`base="id"`). A chain of more
 * than MAX_BASE_CHAIN bases, or a joined search longer than one translation accepts, is refused
 * here, before the text is built (ADR-029).
 */
function readSearch(node: XmlNode, base: ReadonlyMap<string, BaseSearch>): FoundSearch {
  const ref = node.attrs.get('ref');
  if (ref !== undefined && ref !== '') return { savedSearch: ref };
  const query = childText(node, 'query');
  const baseId = node.attrs.get('base');
  const entry = baseId === undefined ? undefined : base.get(baseId);
  if (entry?.found.unreadable !== undefined) return { unreadable: entry.found.unreadable };
  if (entry !== undefined && entry.depth >= MAX_BASE_CHAIN) return { unreadable: CHAIN_TOO_DEEP };
  const parent = entry?.found.search;
  if (query === undefined && !parent) return {};
  if ((parent?.spl.length ?? 0) + (query?.length ?? 0) > MAX_INPUT) return { unreadable: JOINED_TOO_LONG };
  const search: DashboardSearch = { spl: joinSearch(parent?.spl, query) };
  const earliest = childText(node, 'earliest') ?? parent?.earliest;
  const latest = childText(node, 'latest') ?? parent?.latest;
  if (earliest !== undefined) search.earliest = earliest;
  if (latest !== undefined) search.latest = latest;
  return { search };
}

/** A post-process search continues its base search after a pipe. */
export function joinSearch(base: string | undefined, post: string | undefined): string {
  const b = (base ?? '').trim();
  const p = (post ?? '').trim();
  if (b === '') return p;
  if (p === '') return b;
  return `${b} ${p.startsWith('|') ? p : `| ${p}`}`;
}

function readPanel(el: XmlNode, kind: PanelKind, base: ReadonlyMap<string, BaseSearch>): DashboardPanel {
  const panel: DashboardPanel = { kind, dropped: [] };
  const title = childText(el, 'title');
  if (title !== undefined) panel.title = title;
  const description = childText(el, 'description');
  if (description !== undefined) panel.description = description;

  if (kind === 'text') {
    panel.text = htmlToMarkdown(el);
    return panel;
  }

  const searchNode = child(el, 'search');
  if (searchNode) {
    const found = readSearch(searchNode, base);
    if (found.search) panel.search = found.search;
    if (found.savedSearch !== undefined) panel.savedSearch = found.savedSearch;
    if (found.unreadable !== undefined) panel.unreadable = found.unreadable;
  } else {
    // Simple XML before Splunk 6.3.
    const legacy = childText(el, 'searchString') ?? childText(el, 'searchTemplate');
    const post = childText(el, 'searchPostProcess');
    const name = childText(el, 'searchName');
    if (legacy !== undefined || post !== undefined) {
      const search: DashboardSearch = { spl: joinSearch(legacy, post) };
      const earliest = childText(el, 'earliestTime');
      const latest = childText(el, 'latestTime');
      if (earliest !== undefined) search.earliest = earliest;
      if (latest !== undefined) search.latest = latest;
      panel.search = search;
    } else if (name !== undefined) {
      panel.savedSearch = name;
    }
  }

  const options = new Map<string, string>();
  for (const o of childrenNamed(el, 'option')) {
    const name = o.attrs.get('name');
    if (name !== undefined) options.set(name, o.text);
  }
  if (kind === 'chart') panel.chartType = (options.get('charting.chart') ?? 'column').toLowerCase();
  if (kind === 'custom') panel.dropped.push(`It uses a custom visualization (${el.attrs.get('type') ?? 'unknown'}); a table is shown instead.`);
  if (child(el, 'drilldown')) panel.dropped.push('Its drilldown (what a click does) is not carried over.');
  if (options.has('refresh.auto.interval') || childText(searchNode ?? el, 'refresh') !== undefined) {
    panel.dropped.push('Its own refresh interval is not carried over.');
  }
  return panel;
}

function readInput(node: XmlNode, base: ReadonlyMap<string, BaseSearch>, dropped: string[]): DashboardInput | undefined {
  const token = node.attrs.get('token');
  const kind = INPUT_KINDS.get((node.attrs.get('type') ?? 'text').toLowerCase()) ?? 'text';
  if (token === undefined || token === '') {
    // A time input without a token drives the dashboard's own time range.
    if (kind !== 'time') return undefined;
  }
  const input: DashboardInput = { token: token ?? '', kind, choices: [] };
  const label = childText(node, 'label');
  if (label !== undefined) input.label = label;
  for (const c of childrenNamed(node, 'choice')) {
    input.choices.push({ label: c.text === '' ? (c.attrs.get('value') ?? '') : c.text, value: c.attrs.get('value') ?? c.text });
  }

  const def = child(node, 'default') ?? child(node, 'initialValue');
  if (kind === 'time') {
    const earliest = def ? childText(def, 'earliest') : undefined;
    const latest = def ? childText(def, 'latest') : undefined;
    if (earliest !== undefined) input.earliest = earliest;
    if (latest !== undefined) input.latest = latest;
    return input;
  }
  if (def && def.text !== '') input.defaultValue = def.text;

  const searchNode = child(node, 'search');
  const populating = child(node, 'populatingSearch');
  if (searchNode) {
    const found = readSearch(searchNode, base);
    if (found.search) input.search = found.search;
    if (found.unreadable !== undefined) dropped.push(`The search of the input "${token ?? ''}" was not read. ${found.unreadable}`);
    const valueField = childText(node, 'fieldForValue');
    if (valueField !== undefined) input.valueField = valueField;
  } else if (populating && populating.text !== '') {
    input.search = { spl: populating.text };
    const valueField = populating.attrs.get('fieldForValue');
    if (valueField !== undefined) input.valueField = valueField;
  }

  // <valuePrefix>host="</valuePrefix> (or <prefix> on a single-value input): the token is a condition.
  const prefix = childText(node, 'valuePrefix') ?? childText(node, 'prefix');
  const m = prefix === undefined ? null : /^\(?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*"?$/.exec(prefix);
  // The name is written once per use of the token; a longer one is ignored (ADR-029).
  if (m && (m[1] as string).length > MAX_FILTER_FIELD) {
    dropped.push(`The prefix of the input "${token ?? ''}" names a field longer than ${MAX_FILTER_FIELD} characters; it was ignored.`);
  } else if (m) input.filterField = m[1] as string;
  return input;
}

/** A rough, safe reduction of an `<html>` panel to Markdown: headings, paragraphs, lists, links. */
function htmlToMarkdown(el: XmlNode): string {
  const lines: string[] = [];
  const inline = (node: XmlNode): string => {
    const parts: string[] = [];
    for (const c of node.content) {
      if (typeof c === 'string') {
        // Text is data: nothing in it may become Markdown (ADR-029).
        parts.push(escapeText(c));
        continue;
      }
      if (c.name === 'br') {
        parts.push('\n');
        continue;
      }
      if (c.name === 'code') {
        // No code spans (ADR-029, third round): inline code is ordinary escaped text.
        const code = escapeText(deepText(c));
        if (code !== '') parts.push(code);
        continue;
      }
      const inner = inline(c);
      if (inner === '') continue;
      if (c.name === 'b' || c.name === 'strong') parts.push(`**${inner}**`);
      else if (c.name === 'i' || c.name === 'em') parts.push(`*${inner}*`);
      // A link keeps its target only when the target passes the one test (ADR-029); otherwise its text.
      else if (c.name === 'a' && isWebTarget((c.attrs.get('href') ?? '').trim())) parts.push(`[${inner}](${(c.attrs.get('href') as string).trim()})`);
      else parts.push(inner);
    }
    // Pieces that are safe one by one can spell an address or a list marker where they meet.
    return sealLine(
      parts
        .join(' ')
        .replace(/[ \t\r\n]+/g, ' ')
        .replace(/ (\\?[.,;:!?)])/g, '$1'),
    );
  };
  const INLINE = new Set(['b', 'strong', 'i', 'em', 'code', 'a', 'span', 'br', 'u', 'small']);
  /** Text and inline elements next to each other are one paragraph; block elements start a new one. */
  const flow = (content: readonly (string | XmlNode)[]): void => {
    let run: (string | XmlNode)[] = [];
    const flush = (): void => {
      const text = inline({ name: 'p', attrs: new Map(), children: [], text: '', content: run });
      if (text !== '') lines.push(text);
      run = [];
    };
    for (const c of content) {
      if (typeof c === 'string' || INLINE.has(c.name)) {
        run.push(c);
        continue;
      }
      flush();
      const h = /^h([1-6])$/.exec(c.name);
      if (h) lines.push(`${'#'.repeat(Number(h[1]))} ${inline(c)}`);
      else if (c.name === 'li') lines.push(`- ${inline(c)}`);
      else if (c.name === 'p' || c.name === 'pre') lines.push(inline(c));
      else if (c.name !== 'script' && c.name !== 'style' && c.name !== 'title') flow(c.content);
    }
    flush();
  };
  flow(el.content);
  if (lines.length === 0) {
    const text = escapeText(deepText(el).replace(/\s+/g, ' '));
    if (text !== '') lines.push(text);
  }
  return lines.filter((l) => l.trim() !== '').join('\n\n');
}
