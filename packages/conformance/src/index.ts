import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One conformance case: SPL in, exact DQL and exact diagnostics out. See docs/spec/testing.md. */
export interface ConformanceCase {
  file: string;
  title: string;
  spl: string;
  dql: string;
  meta: CaseMeta;
}

export interface CaseMeta {
  /** Name of a file in mappings/ (without .yaml); omitted = no mapping. */
  mapping?: string;
  options?: { timeRange?: { earliest?: string; latest?: string }; strict?: boolean };
  confidence: 'high' | 'review' | 'low' | 'none';
  /** Expected warnings and errors as "CODE@stage", any order. Info notes are not listed. */
  diagnostics: string[];
  /** True only after the tenant suite accepted the DQL (never set by hand). */
  verified: boolean;
  /** Where the expected behaviour comes from. */
  source: string;
  /** Set to false when the expected DQL deliberately fails the offline syntax check. */
  syntaxOk?: boolean;
}

export const CASES_DIR = fileURLToPath(new URL('../cases/', import.meta.url));
export const MAPPINGS_DIR = fileURLToPath(new URL('../mappings/', import.meta.url));

const FENCE = /^```(spl|dql|json)\s*$/;

/** Parses every cases/*.md file. Throws on malformed files so broken cases cannot pass silently. */
export function loadCases(dir: string = CASES_DIR): ConformanceCase[] {
  const out: ConformanceCase[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    out.push(...parseCaseFile(file, readFileSync(join(dir, file), 'utf8')));
  }
  return out;
}

export function parseCaseFile(file: string, text: string): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const lines = text.split('\n');
  let title: string | undefined;
  let blocks: Record<string, string> = {};
  let fence: string | undefined;
  let buf: string[] = [];
  const finish = (): void => {
    if (title === undefined) return;
    const { spl, dql, json } = blocks;
    if (spl === undefined || dql === undefined || json === undefined) {
      throw new Error(`${file}: case "${title}" needs spl, dql and json blocks`);
    }
    const meta = JSON.parse(json) as CaseMeta;
    for (const key of ['confidence', 'diagnostics', 'verified', 'source'] as const) {
      if (meta[key] === undefined) throw new Error(`${file}: case "${title}" is missing "${key}"`);
    }
    cases.push({ file, title, spl, dql, meta });
  };
  for (const line of lines) {
    if (fence !== undefined) {
      if (line.trim() === '```') {
        blocks[fence] = buf.join('\n');
        fence = undefined;
        buf = [];
      } else {
        buf.push(line);
      }
      continue;
    }
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      finish();
      title = (heading[1] as string).trim();
      blocks = {};
      continue;
    }
    const open = FENCE.exec(line);
    if (open && title !== undefined) fence = open[1];
  }
  if (fence !== undefined) throw new Error(`${file}: unclosed code block`);
  finish();
  return cases;
}

export function mappingPath(name: string): string {
  return join(MAPPINGS_DIR, `${name}.yaml`);
}
