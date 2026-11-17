import { checkDqlExpression, parseMappingConfig, parseSavedSearches, safeFileName, translate } from '@spl2dql/core';
import { describe, expect, it } from 'vitest';

/** Regression tests for the independent security review of 2026-11-14. */
const fast = (label: string, f: () => void, ms = 1500): void => {
  const t = performance.now();
  f();
  expect(performance.now() - t, label).toBeLessThan(ms);
};

describe('linear time on hostile input', () => {
  it('long time modifiers (finding 1)', () => {
    fast('earliest', () => {
      const r = translate(`index=web earliest=${'+1'.repeat(100_000)}!`);
      expect(r.diagnostics.some((d) => d.code === 'SPL3015')).toBe(true);
    });
    fast('latest', () => translate(`index=web latest=${'-1d'.repeat(60_000)}@`));
  });

  it('many empty stages (finding 2)', () => {
    fast('pipes', () => {
      const r = translate(`index=web${'|'.repeat(400_000)}`);
      expect(r.diagnostics.some((d) => d.code === 'SPL1006')).toBe(true);
    });
    fast('valid long pipeline', () => translate(`index=web${' | eval x=1'.repeat(4_000)}`));
  });

  it('savedsearches.conf continuation lines (finding 3)', () => {
    fast('continuations', () => {
      const r = parseSavedSearches(`[a]\nsearch = x\\\n${'y\\\n'.repeat(800_000)}z\n`, 'f');
      expect(r).toHaveLength(1);
    });
  });
});

describe('output hygiene', () => {
  it('escapes control characters in DQL strings and strips them from comments and names (finding 7)', () => {
    const esc = '\u001b]0;pwned\u0007';
    const r = translate(`index=web "${esc}" | eval '${esc}x'=1 | iplocation ${esc}`);
    expect(r.dql).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(r.dql).toContain('\\u001b');
  });

  it('refuses comments inside mapping filters (finding 9)', () => {
    expect(checkDqlExpression('a == 1 //').ok).toBe(false);
    const m = parseMappingConfig({ version: 1, indexes: { web: { filter: 'a == 1 // swallow' } } });
    expect(m.ok).toBe(false);
  });

  it('escapes Windows reserved names that carry an extension', () => {
    expect(safeFileName('con.x', new Set())).toBe('_con.x');
    expect(safeFileName('LPT1', new Set())).toBe('_LPT1');
  });
});
