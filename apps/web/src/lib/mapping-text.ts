import { collectMappingNeeds, type Diagnostic, type MappingSections } from '@spl2dql/core';
import { type Document, isMap, isScalar, parseDocument, Scalar } from 'yaml';

/**
 * Changes to the mapping text that keep the person's comments and layout. Loaded only when needed
 * (the YAML library is not part of the first paint).
 */

export type Section = 'indexes' | 'sourcetypes' | 'fields' | 'macros' | 'lookups' | 'eventtypes' | 'metrics' | 'datamodels';

export interface Entry {
  section: string;
  name: string;
  value: unknown;
}

/** A new entry is a starting point, not an answer: it says so in the file. */
export const ADDED_COMMENT = ' Added by spl2dql: replace with where this lives in Grail.';

const SKELETON: Record<Exclude<Section, 'datamodels'>, (name: string) => unknown> = {
  indexes: () => ({ dataObject: 'logs', buckets: [] }),
  sourcetypes: () => ({ filter: 'true' }),
  fields: (n) => n,
  macros: () => ({ definition: 'TODO' }),
  lookups: (n) => ({ path: `/lookups/${n.replace(/[^A-Za-z0-9_.-]/g, '_')}` }),
  eventtypes: () => 'true',
  metrics: (n) => n,
};

export function skeleton(section: Exclude<Section, 'datamodels'>, name: string): Entry {
  return { section, name, value: SKELETON[section](name) };
}

/** A data model the current search reads, as an entry to fill in. */
export function datamodelSkeleton(name: string, fields: readonly string[]): Entry {
  return { section: 'datamodels', name, value: { dataObject: 'logs', filter: 'true', fields: Object.fromEntries(fields.map((f) => [f, f])) } };
}

/** The mapping entries that would resolve these notes (SPL4001–SPL4008), one per name. */
export function entriesFor(diagnostics: Iterable<Diagnostic>): Entry[] {
  const needs = collectMappingNeeds(diagnostics);
  const out: Entry[] = [];
  for (const section of ['indexes', 'sourcetypes', 'fields', 'macros', 'lookups', 'eventtypes', 'metrics'] as const) {
    for (const name of needs[section]) out.push(skeleton(section, name));
  }
  for (const m of needs.datamodels) out.push(datamodelSkeleton(m.name, m.fields));
  return out;
}

function open(text: string): Document | undefined {
  const doc = parseDocument(text.trim() === '' ? 'version: 1\n' : text, { uniqueKeys: true });
  return doc.errors.length > 0 ? undefined : doc;
}

/** The section as a block map, so new entries can carry a comment ("indexes: {}" becomes a block). */
function section(doc: Document, name: string) {
  let map = doc.get(name, true);
  if (!isMap(map)) {
    doc.set(name, doc.createNode({}));
    map = doc.get(name, true);
  }
  if (isMap(map)) map.flow = false;
  return isMap(map) ? map : undefined;
}

/**
 * Adds entries the mapping does not have yet, each marked with a comment. Returns the new text and
 * how many were added; undefined when the text is not valid YAML.
 */
export function addEntries(text: string, entries: readonly Entry[]): { text: string; added: number } | undefined {
  const doc = open(text);
  if (!doc) return undefined;
  let added = 0;
  for (const e of entries) {
    if (doc.hasIn([e.section, e.name])) continue;
    const map = section(doc, e.section);
    if (!map) continue;
    const pair = doc.createPair(e.name, e.value);
    if (isScalar(pair.key)) pair.key.commentBefore = ADDED_COMMENT;
    else pair.key = Object.assign(new Scalar(e.name), { commentBefore: ADDED_COMMENT });
    map.items.push(pair);
    added++;
  }
  return { text: doc.toString({ lineWidth: 0 }), added };
}

const IMPORTED = ['macros', 'extractions', 'eventtypes', 'tags'] as const;

/**
 * Adds definitions read from Splunk configuration files to the mapping text. An entry the mapping
 * already has is left alone, and so are its comments and layout.
 */
export function addToMappingText(text: string, sections: MappingSections): { text: string; added: number } | undefined {
  const doc = open(text);
  if (!doc) return undefined;
  let added = 0;
  for (const name of IMPORTED) {
    const entries = sections[name];
    if (!entries) continue;
    if (!doc.has(name) || doc.get(name) === null) doc.set(name, doc.createNode({}));
    for (const [key, value] of Object.entries(entries)) {
      if (doc.hasIn([name, key])) continue;
      doc.setIn([name, key], doc.createNode(value));
      added++;
    }
  }
  return { text: doc.toString({ lineWidth: 0 }), added };
}

/** Where an entry starts in the text, to put the caret on it. */
export function findEntry(text: string, sectionName: string, name: string): number | undefined {
  const doc = parseDocument(text, { uniqueKeys: true });
  const map = doc.get(sectionName, true);
  if (!isMap(map)) return undefined;
  for (const pair of map.items) {
    if (isScalar(pair.key) && String(pair.key.value) === name) return pair.key.range?.[0];
  }
  return undefined;
}
