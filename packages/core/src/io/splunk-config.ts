/**
 * Turns Splunk configuration files into mapping-file sections (docs/spec/mapping-config.md →
 * "From Splunk configuration files"). Pure: text in, plain data out. Nothing is guessed — a
 * definition that cannot be carried over is listed in `skipped` with the reason.
 *
 *   macros.conf                 → macros
 *   props.conf, transforms.conf → extractions (EXTRACT-… and REPORT-… with a regular expression)
 *   eventtypes.conf             → eventtypes (the search translated to a DQL condition)
 *   tags.conf                   → tags (the tagged eventtypes and field values, joined with "or")
 */

import { checkDqlExpression } from '../dql/check.ts';
import { regexToDpl } from '../lower/regex.ts';
import { translateCondition } from '../translate.ts';
import type { MappingConfig } from '../types.ts';
import { dict } from '../util/dict.ts';
import { type ConfStanza, confTrue, parseConf } from './conf.ts';

export interface ConfigFile {
  /** File name or path; only the base name decides what the file is. */
  name: string;
  text: string;
}

export type ConfigKind = 'macros' | 'props' | 'transforms' | 'eventtypes' | 'tags';

/** Mapping-file sections as plain data, ready to be written as YAML or merged into a mapping. */
export interface MappingSections {
  macros?: Record<string, { args?: string[]; definition: string }>;
  extractions?: Record<string, { from: string; dpl: string }>;
  eventtypes?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface ImportNote {
  /** Section the entry belongs to. */
  section: 'macros' | 'extractions' | 'eventtypes' | 'tags';
  /** Macro, field, eventtype or tag name. */
  name: string;
  /** Why it was left out, in plain words. */
  reason: string;
}

export interface ConfigImport {
  sections: MappingSections;
  /** Number of entries carried over per section. */
  counts: Record<'macros' | 'extractions' | 'eventtypes' | 'tags', number>;
  skipped: ImportNote[];
}

const KINDS: Readonly<Record<string, ConfigKind>> = dict({
  'macros.conf': 'macros',
  'props.conf': 'props',
  'transforms.conf': 'transforms',
  'eventtypes.conf': 'eventtypes',
  'tags.conf': 'tags',
});

const MACRO_NAME = /^[A-Za-z0-9_.:-]+(\(\d{1,2}\))?$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
const SAFE_KEY = /^[^\s`"|[\]]{1,256}$/;
const MAX_TEXT = 10_000;
/** Characters of imported definitions in one import, all sections together (ADR-029). */
export const MAX_IMPORTED = 5_000_000;
/** Entries per section: the mapping file's own limit. */
const MAX_ENTRIES = 10_000;

type Section = ImportNote['section'];

/**
 * Holds what is imported to the mapping file's own limits (entries per section) and to the total
 * budget, so `mapping init` can always read back what it wrote. Charged before a value is kept,
 * and for tags before the combined condition is built. Says once per section, and once for the
 * budget, what was left out.
 */
class Keeper {
  private left = MAX_IMPORTED;
  private readonly counts = new Map<Section, number>();
  private readonly full = new Set<Section | 'budget'>();
  private readonly skipped: ImportNote[];
  constructor(skipped: ImportNote[]) {
    this.skipped = skipped;
  }

  keep(section: Section, name: string, size: number): boolean {
    const count = this.counts.get(section) ?? 0;
    if (count >= MAX_ENTRIES) {
      if (!this.full.has(section)) {
        this.full.add(section);
        this.skipped.push({ section, name, reason: `There are more than ${MAX_ENTRIES} entries; this one and the rest were left out.` });
      }
      return false;
    }
    if (size > this.left) {
      if (!this.full.has('budget')) {
        this.full.add('budget');
        this.skipped.push({
          section,
          name,
          reason: `The configuration files hold more than ${MAX_IMPORTED} characters of definitions; this one and the rest were left out.`,
        });
      }
      return false;
    }
    this.left -= size;
    this.counts.set(section, count + 1);
    return true;
  }
}

/** A definition the import could not process; one bad line never ends the whole import (ADR-029). */
const UNREADABLE = 'This definition could not be processed and was skipped.';

/** What a file is, from its base name; undefined for anything else. */
export function configKind(fileName: string): ConfigKind | undefined {
  const base = fileName.replace(/^.*[\\/]/, '').toLowerCase();
  return KINDS[base];
}

/**
 * Reads the given files in order; a later file overrides an earlier one stanza key by key, so pass
 * `default/` before `local/`. `mapping` is used to translate eventtype searches (field and
 * sourcetype names resolve through it).
 */
export function importSplunkConfig(files: readonly ConfigFile[], mapping?: MappingConfig): ConfigImport {
  const merged: Record<ConfigKind, Map<string, ConfStanza>> = {
    macros: new Map(),
    props: new Map(),
    transforms: new Map(),
    eventtypes: new Map(),
    tags: new Map(),
  };
  for (const file of files) {
    const kind = configKind(file.name);
    if (!kind) continue;
    for (const stanza of parseConf(file.text)) {
      const existing = merged[kind].get(stanza.name);
      if (!existing) merged[kind].set(stanza.name, stanza);
      else for (const [k, v] of stanza.values) existing.values.set(k, v);
    }
  }

  const skipped: ImportNote[] = [];
  const keeper = new Keeper(skipped);
  const sections: MappingSections = {};
  const counts = { macros: 0, extractions: 0, eventtypes: 0, tags: 0 };

  const macros = importMacros(merged.macros, skipped, keeper);
  if (Object.keys(macros).length > 0) sections.macros = macros;
  counts.macros = Object.keys(macros).length;

  const extractions = importExtractions(merged.props, merged.transforms, skipped, keeper);
  if (Object.keys(extractions).length > 0) sections.extractions = extractions;
  counts.extractions = Object.keys(extractions).length;

  const options = mapping ? { mapping } : {};
  const eventtypes = new Map<string, string>();
  const importEventtype = (name: string, stanza: ConfStanza): void => {
    const search = stanza.values.get('search');
    if (confTrue(stanza.values.get('disabled'))) return;
    if (!SAFE_KEY.test(name)) {
      skipped.push({ section: 'eventtypes', name, reason: 'The name contains characters a mapping key cannot hold.' });
      return;
    }
    if (search === undefined || search === '') {
      skipped.push({ section: 'eventtypes', name, reason: 'The eventtype has no search.' });
      return;
    }
    const condition = translateCondition(search, options).condition;
    if (condition === undefined || condition.length > MAX_TEXT || !checkDqlExpression(condition).ok) {
      skipped.push({ section: 'eventtypes', name, reason: `Its search is more than a filter and was not converted: ${clip(search)}` });
      return;
    }
    if (keeper.keep('eventtypes', name, condition.length)) eventtypes.set(name, condition);
  };
  for (const [name, stanza] of merged.eventtypes) {
    if (name === 'default') continue;
    try {
      importEventtype(name, stanza);
    } catch {
      skipped.push({ section: 'eventtypes', name, reason: UNREADABLE });
    }
  }
  if (eventtypes.size > 0) sections.eventtypes = Object.fromEntries(eventtypes);
  counts.eventtypes = eventtypes.size;

  const tags = importTags(merged.tags, eventtypes, options, skipped, keeper);
  if (Object.keys(tags).length > 0) sections.tags = tags;
  counts.tags = Object.keys(tags).length;

  return { sections, counts, skipped };
}

function importMacros(stanzas: Map<string, ConfStanza>, skipped: ImportNote[], keeper: Keeper): Record<string, { args?: string[]; definition: string }> {
  const out = new Map<string, { args?: string[]; definition: string }>();
  for (const [name, stanza] of stanzas) {
    if (name === 'default') continue;
    const skip = (reason: string): void => void skipped.push({ section: 'macros', name, reason });
    if (!MACRO_NAME.test(name)) {
      skip('The name contains characters a mapping key cannot hold.');
      continue;
    }
    const definition = stanza.values.get('definition');
    if (definition === undefined || definition === '') {
      skip('The macro has no definition.');
      continue;
    }
    if (definition.length > MAX_TEXT) {
      skip(`The definition is longer than ${MAX_TEXT} characters.`);
      continue;
    }
    if (confTrue(stanza.values.get('iseval'))) {
      skip('It is an eval-based macro (iseval = 1): Splunk computes its text when the search runs.');
      continue;
    }
    const args = (stanza.values.get('args') ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '');
    const declared = Number(/\((\d+)\)$/.exec(name)?.[1] ?? 0);
    if (declared !== args.length || args.some((a) => !ARG_NAME.test(a))) {
      skip(`The name says ${declared} argument(s) but "args" lists ${args.length}.`);
      continue;
    }
    if (keeper.keep('macros', name, definition.length)) out.set(name, args.length > 0 ? { args, definition } : { definition });
  }
  return Object.fromEntries(out);
}

/** EXTRACT-<class> = <regex> [in <field>]  and  REPORT-<class> = <transform>, … */
function importExtractions(
  props: Map<string, ConfStanza>,
  transforms: Map<string, ConfStanza>,
  skipped: ImportNote[],
  keeper: Keeper,
): Record<string, { from: string; dpl: string }> {
  const out = new Map<string, { from: string; dpl: string }>();
  const add = (label: string, regex: string, source: string): void => {
    const from = source === '_raw' ? 'content' : source;
    if (!FIELD_NAME.test(from)) {
      skipped.push({ section: 'extractions', name: label, reason: `The source field "${source}" is not a plain field name.` });
      return;
    }
    const conv = regexToDpl(regex, { captures: true });
    if (!conv.ok) {
      skipped.push({ section: 'extractions', name: label, reason: `${conv.reason} Pattern: ${clip(regex)}` });
      return;
    }
    if (conv.captures.length === 0) {
      skipped.push({ section: 'extractions', name: label, reason: 'The pattern has no named group, so it creates no field.' });
      return;
    }
    for (const c of conv.captures) {
      if (!SAFE_KEY.test(c.name)) continue;
      const existing = out.get(c.name);
      if (existing && (existing.dpl !== conv.dpl || existing.from !== from)) {
        skipped.push({ section: 'extractions', name: c.name, reason: `${label} extracts it differently from an earlier definition; the first one was kept.` });
        continue;
      }
      if (!existing && !keeper.keep('extractions', c.name, conv.dpl.length)) continue;
      out.set(c.name, { from, dpl: conv.dpl });
    }
  };

  const entry = (stanzaName: string, key: string, value: string): void => {
    if (/^EXTRACT-/.test(key)) {
      const m = /^(.*\S)\s+in\s+([A-Za-z_][A-Za-z0-9_.]*)$/s.exec(value);
      add(`[${stanzaName}] ${key}`, m ? (m[1] as string) : value, m ? (m[2] as string) : '_raw');
    } else if (/^REPORT-/.test(key)) {
      for (const ref of value.split(',').map((x) => x.trim())) {
        if (ref === '') continue;
        const label = `[${stanzaName}] ${key} → ${ref}`;
        const t = transforms.get(ref);
        if (!t) {
          skipped.push({ section: 'extractions', name: label, reason: 'The transform is not in the transforms.conf that was given.' });
          continue;
        }
        const regex = t.values.get('REGEX');
        if (regex === undefined || regex === '') {
          skipped.push({ section: 'extractions', name: label, reason: 'The transform splits by delimiters (no REGEX); write the pattern by hand.' });
          continue;
        }
        const named = nameGroups(regex, t.values.get('FORMAT'));
        if (named === undefined) {
          skipped.push({ section: 'extractions', name: label, reason: 'Its FORMAT builds field names from the event itself ($1::$2).' });
          continue;
        }
        add(label, named, t.values.get('SOURCE_KEY') ?? '_raw');
      }
    }
  };

  for (const [stanzaName, stanza] of props) {
    for (const [key, value] of stanza.values) {
      try {
        entry(stanzaName, key, value);
      } catch {
        skipped.push({ section: 'extractions', name: `[${stanzaName}] ${key}`, reason: UNREADABLE });
      }
    }
  }
  return Object.fromEntries(out);
}

/**
 * `FORMAT = user::$1 src::$2` names numbered groups. Rewrites the regex so those groups are named and
 * every other plain group is non-capturing. Returns undefined when a field name is itself a group.
 */
export function nameGroups(regex: string, format: string | undefined): string | undefined {
  if (format === undefined || format.trim() === '') return regex;
  const names = new Map<number, string>();
  for (const pair of format.trim().split(/\s+/)) {
    const m = /^("?)([^:"]+)\1::\$(\d+)$/.exec(pair);
    if (!m) return /\$\d+::/.test(pair) ? undefined : regex;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[2] as string)) return undefined;
    names.set(Number(m[3]), m[2] as string);
  }
  let out = '';
  let group = 0;
  for (let i = 0; i < regex.length; i++) {
    const c = regex[i] as string;
    if (c === '\\') {
      out += c + (regex[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '[') {
      // Copy a character class untouched: a "(" inside it is a plain character.
      let end = i + 1;
      if (regex[end] === '^') end++;
      if (regex[end] === ']') end++;
      while (end < regex.length && regex[end] !== ']') end += regex[end] === '\\' ? 2 : 1;
      out += regex.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '(') {
      if (regex[i + 1] !== '?') {
        group++;
        const name = names.get(group);
        out += name ? `(?<${name}>` : '(?:';
        continue;
      }
      if (/^\(\?(P?<[A-Za-z_]|')/.test(regex.slice(i, i + 5))) group++;
    }
    out += c;
  }
  return out;
}

function importTags(
  stanzas: Map<string, ConfStanza>,
  eventtypes: ReadonlyMap<string, string>,
  options: { mapping?: MappingConfig },
  skipped: ImportNote[],
  keeper: Keeper,
): Record<string, string> {
  const parts = new Map<string, string[]>();
  const failed = new Set<string>();
  for (const [stanzaName, stanza] of stanzas) {
    const eq = stanzaName.indexOf('=');
    if (stanzaName === 'default' || eq <= 0) continue;
    const fieldName = stanzaName.slice(0, eq).trim();
    const value = decodeTagValue(stanzaName.slice(eq + 1).trim());
    let condition: string | undefined;
    if (fieldName === 'eventtype') condition = eventtypes.get(value);
    else if (FIELD_NAME.test(fieldName)) condition = translateCondition(`${fieldName}="${value.replace(/(["\\])/g, '\\$1')}"`, options).condition;
    for (const [tag, state] of stanza.values) {
      if (state.trim().toLowerCase() !== 'enabled' || !SAFE_KEY.test(tag)) continue;
      if (condition === undefined) {
        failed.add(tag);
        skipped.push({ section: 'tags', name: tag, reason: `It is set on ${stanzaName}, which could not be converted.` });
        continue;
      }
      const list = parts.get(tag) ?? [];
      list.push(condition);
      parts.set(tag, list);
    }
  }
  const out = new Map<string, string>();
  for (const [tag, list] of parts) {
    // A tag with one unconverted member would match too little; leave the whole tag to the user.
    if (failed.has(tag)) continue;
    // The length is known before the combined condition is built: (a) or (b) …
    let length = list.length === 1 ? (list[0] as string).length : -4;
    if (list.length > 1) for (const c of list) length += c.length + 6;
    if (length > MAX_TEXT) {
      skipped.push({ section: 'tags', name: tag, reason: 'The combined condition is too long.' });
      continue;
    }
    if (!keeper.keep('tags', tag, length)) continue;
    out.set(tag, list.length === 1 ? (list[0] as string) : list.map((c) => `(${c})`).join(' or '));
  }
  return Object.fromEntries(out);
}

/** tags.conf writes field values URL-encoded: [host=web%2D01]. */
function decodeTagValue(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 157)}…` : one;
}

/**
 * Lays imported sections under a mapping file's own content: an entry the mapping already has wins.
 * Both arguments are plain mapping-file data (before validation).
 */
export function mergeMappingSections(base: Record<string, unknown>, imported: MappingSections): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries([['version', 1], ...Object.entries(base)]);
  for (const key of ['macros', 'extractions', 'eventtypes', 'tags'] as const) {
    const extra = imported[key];
    if (!extra) continue;
    const own = out[key];
    const ownRecord = typeof own === 'object' && own !== null && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
    // The mapping's own entries win and come first in the count; imported ones fill up to the
    // mapping file's limit of entries per section, so the result always validates.
    const ownEntries = Object.entries(ownRecord);
    const room = Math.max(0, MAX_ENTRIES - ownEntries.length);
    const added = Object.entries(extra)
      .filter(([k]) => !Object.hasOwn(ownRecord, k))
      .slice(0, room);
    out[key] = Object.fromEntries([...added, ...ownEntries]);
  }
  return out;
}
