import { importSplunkConfig, type MappingConfig, parseMappingConfig } from '@spl2dql/core';
import { parse as parseYaml } from 'yaml';
import { exampleMappingText } from './example-mapping.ts';
import { SAMPLE_CONFIG } from './sample.ts';

/** Which mapping a request uses: the person's own text, or the example mapping (ADR-030). */
export type MappingRef = { own: string } | { example: true };

/** What the worker did with the mapping, for the line above the notes. */
export type MappingUse = 'own' | 'example' | 'none' | 'invalid';

export interface ResolvedMapping {
  mapping: MappingConfig | undefined;
  use: MappingUse;
}

const YAML_OPTIONS = { schema: 'core', maxAliasCount: 100, uniqueKeys: true, merge: false } as const;

let ownText: string | undefined;
let ownResolved: ResolvedMapping = { mapping: undefined, use: 'none' };
let example: ResolvedMapping | undefined;

function fromText(text: string): ResolvedMapping {
  if (text.trim() === '') return { mapping: undefined, use: 'none' };
  let data: unknown;
  try {
    data = parseYaml(text, YAML_OPTIONS);
  } catch {
    return { mapping: undefined, use: 'invalid' };
  }
  if (data === null || data === undefined) return { mapping: undefined, use: 'none' };
  const parsed = parseMappingConfig(data);
  return parsed.ok ? { mapping: parsed.value, use: 'own' } : { mapping: undefined, use: 'invalid' };
}

/**
 * The example mapping: the sample app's mapping file and the entries the built-in examples need,
 * with the definitions read from the sample app's .conf files added the way a drop adds them (an
 * entry the mapping already has is kept).
 */
function exampleMapping(): ResolvedMapping {
  if (example) return example;
  const data = parseYaml(exampleMappingText(), YAML_OPTIONS) as Record<string, Record<string, unknown> | undefined>;
  const base = parseMappingConfig(data);
  const imported = importSplunkConfig(SAMPLE_CONFIG, base.ok ? base.value : undefined);
  for (const [section, entries] of Object.entries(imported.sections)) {
    if (!entries) continue;
    data[section] = { ...entries, ...(data[section] ?? {}) };
  }
  const parsed = parseMappingConfig(data);
  example = parsed.ok ? { mapping: parsed.value, use: 'example' } : { mapping: undefined, use: 'none' };
  return example;
}

export function resolveMapping(ref: MappingRef | undefined): ResolvedMapping {
  if (!ref) return { mapping: undefined, use: 'none' };
  if ('example' in ref) return exampleMapping();
  if (ref.own !== ownText) {
    ownText = ref.own;
    ownResolved = fromText(ref.own);
  }
  return ownResolved;
}
