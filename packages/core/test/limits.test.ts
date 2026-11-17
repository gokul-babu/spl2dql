import { parseMappingConfig, translate } from '@spl2dql/core';
import { describe, expect, it } from 'vitest';

describe('limits (SPL1006)', () => {
  it('refuses input over 1,000,000 characters', () => {
    const r = translate('a'.repeat(1_000_001));
    expect(r.confidence).toBe('none');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SPL1006']);
  });

  it('stops macro expansion that grows beyond the limit', () => {
    const mapping = parseMappingConfig({
      version: 1,
      macros: {
        big: { definition: 'x'.repeat(9_000) },
        b1: { definition: '`big``big``big``big``big``big``big``big``big``big`' },
      },
    });
    if (!mapping.ok) throw new Error(JSON.stringify(mapping.issues));
    const r = translate(`index=web ${'`b1` '.repeat(20)}`, { mapping: mapping.value });
    expect(r.diagnostics.some((d) => d.code === 'SPL1006')).toBe(true);
  });

  it('refuses subsearches nested more than 16 deep', () => {
    let spl = 'index=a error | fields user';
    for (let i = 0; i < 18; i++) spl = `index=a [search ${spl}] | fields user`;
    const r = translate(spl);
    expect(r.diagnostics.some((d) => d.code === 'SPL1006')).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'SPL1008')).toBe(false);
  });

  it('handles very long but valid searches quickly', () => {
    const spl = `index=web ${Array.from({ length: 2000 }, (_, i) => `host=h${i}`).join(' OR ')} | stats count by host`;
    const start = performance.now();
    const r = translate(spl);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.confidence).not.toBe('none');
  });

  it('stays linear on pathological quoting and brackets', () => {
    for (const spl of ['"'.repeat(200_000), '['.repeat(200_000), '`'.repeat(200_000), `index=a ${'\\'.repeat(200_000)}`, `| eval x=${'('.repeat(100_000)}`]) {
      const start = performance.now();
      const r = translate(spl);
      expect(performance.now() - start).toBeLessThan(3000);
      expect(r.diagnostics.some((d) => d.code === 'SPL1008')).toBe(false);
    }
  });
});

describe('names that collide with Object.prototype', () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '__defineGetter__'];
  it('are treated as ordinary field, function and command names', () => {
    for (const n of names) {
      for (const spl of [
        `index=web ${n}=1 | stats count by ${n}`,
        `index=web | eval ${n}=${n}(1) | table ${n}`,
        `index=web | ${n} x`,
        `index=web | stats ${n}(x) | sort -${n}`,
        `index=web | eval x=strftime(_time, "%${n}")`,
        `index=web earliest=-1${n} | timechart span=1${n} count`,
        `index=web | streamstats window=2 ${n}(x)`,
        `| mstats ${n}(m)`,
      ]) {
        const r = translate(spl);
        expect(
          r.diagnostics.some((d) => d.code === 'SPL1008'),
          spl,
        ).toBe(false);
      }
    }
  });

  it('do not pollute prototypes through the mapping file', () => {
    const input = JSON.parse('{"version":1,"__proto__":{"polluted":true},"fields":{"__proto__":"x","constructor":"y"},"macros":{"__proto__":"z"}}');
    const r = parseMappingConfig(input);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (r.ok) {
      expect(translate('index=web constructor=1', { mapping: r.value }).dql).toContain('y == 1');
    } else {
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });
});
