import { readFileSync } from 'node:fs';
import { type ConformanceCase, loadCases, mappingPath } from '@spl2dql/conformance';
import { allDiagnosticDocs, checkDqlSyntax, type MappingConfig, parseMappingConfig, translate } from '@spl2dql/core';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const mappings = new Map<string, MappingConfig>();
function mapping(name: string): MappingConfig {
  const cached = mappings.get(name);
  if (cached) return cached;
  const parsed = parseMappingConfig(parseYaml(readFileSync(mappingPath(name), 'utf8')));
  if (!parsed.ok) throw new Error(`mapping ${name}: ${JSON.stringify(parsed.issues)}`);
  mappings.set(name, parsed.value);
  return parsed.value;
}

function run(c: ConformanceCase) {
  return translate(c.spl, {
    ...(c.meta.mapping ? { mapping: mapping(c.meta.mapping) } : {}),
    ...(c.meta.options?.timeRange ? { timeRange: c.meta.options.timeRange } : {}),
    ...(c.meta.options?.strict ? { strict: true } : {}),
  });
}

const cases = loadCases();
const seenCodes = new Set<string>();

describe('conformance corpus', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  for (const c of cases) {
    it(`${c.file} › ${c.title}`, () => {
      const result = run(c);
      for (const d of result.diagnostics) seenCodes.add(d.code);
      expect(result.dql, 'DQL').toBe(c.dql.trim());
      const actual = result.diagnostics
        .filter((d) => d.severity !== 'info')
        .map((d) => `${d.code}@${d.stageIndex}`)
        .sort();
      expect(actual, 'warnings and errors').toEqual([...c.meta.diagnostics].sort());
      expect(result.confidence, 'confidence').toBe(c.meta.confidence);
      if (c.meta.syntaxOk !== false && result.dql.split('\n').some((l) => l.trim() !== '' && !l.startsWith('//'))) {
        expect(checkDqlSyntax(result.dql).issues, 'offline syntax check').toEqual([]);
      }
    });
  }

  it('triggers every registered diagnostic code somewhere', () => {
    // SPL1008 (internal error) and SPL3017 (our own output failing the check) must never occur.
    // SPL1006 (size and depth limits) needs inputs too large for a case file; see limits.test.ts.
    const exempt = new Set(['SPL1006', 'SPL1008', 'SPL3017']);
    const missing = allDiagnosticDocs()
      .map((d) => d.code)
      .filter((code) => !exempt.has(code) && !seenCodes.has(code));
    expect(missing).toEqual([]);
  });
});
