import { checkDqlSyntax, translate } from '@spl2dql/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const FRAGMENTS = [
  'index=web',
  'index=*',
  'sourcetype=x',
  'earliest=-24h@h',
  'latest=now',
  'error',
  'fail*',
  '"quoted phrase"',
  'host=a',
  'status>=500',
  'NOT',
  'OR',
  'AND',
  '(',
  ')',
  '[',
  ']',
  '|',
  '"',
  '`',
  '```',
  'search',
  'stats',
  'count',
  'avg(bytes)',
  'count(eval(x>1))',
  'as',
  'by',
  'host,',
  'eval',
  'x=1',
  'y=x+1,',
  'where',
  'x>1',
  'table',
  'fields',
  '-',
  'rename',
  'a',
  'AS',
  'b',
  'sort',
  '-count',
  'head',
  '10',
  'dedup',
  'rex',
  '"(?<n>\\d+)"',
  'field=_raw',
  'timechart',
  'span=5m',
  'top',
  'limit=5',
  'lookup',
  'join',
  'append',
  'transaction',
  'spath',
  'mvexpand',
  'makeresults',
  'tstats',
  'mstats',
  'inputlookup',
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  '\n',
  ' ',
  '\\',
  "'",
  '=',
  '==',
  '<',
  '{}',
];

const splLike = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 40 }).map((parts) => parts.join(' '));
const anyText = fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: 'binary', maxLength: 200 }), splLike);

describe('translate() invariants', () => {
  it('never throws and never reports an internal error', () => {
    fc.assert(
      fc.property(anyText, (input) => {
        const r = translate(input);
        expect(r.diagnostics.some((d) => d.code === 'SPL1008')).toBe(false);
      }),
      { numRuns: 4000 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(splLike, (input) => {
        expect(translate(input)).toEqual(translate(input));
      }),
      { numRuns: 500 },
    );
  });

  it('keeps spans inside the input and the output, and stages in order', () => {
    fc.assert(
      fc.property(splLike, (input) => {
        const r = translate(input);
        let last = -1;
        for (const s of r.stages) {
          expect(s.spl.start).toBeGreaterThanOrEqual(0);
          expect(s.spl.end).toBeLessThanOrEqual(input.length);
          expect(s.spl.start).toBeLessThanOrEqual(s.spl.end);
          expect(s.spl.start).toBeGreaterThanOrEqual(last);
          last = s.spl.start;
          for (const d of s.dql) {
            expect(d.start).toBeGreaterThanOrEqual(0);
            expect(d.end).toBeLessThanOrEqual(r.dql.length);
          }
        }
        for (const d of r.diagnostics) {
          expect(d.span.start).toBeGreaterThanOrEqual(0);
          expect(d.span.end).toBeLessThanOrEqual(Math.max(input.length, d.span.start));
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('only produces command lines, continuation lines and single-line comments', () => {
    fc.assert(
      fc.property(anyText, (input) => {
        const lines = translate(input)
          .dql.split('\n')
          .filter((l) => l !== '');
        let seenCommand = false;
        for (const line of lines) {
          if (line.startsWith('// ')) continue;
          if (!seenCommand) {
            expect(line).toMatch(/^[A-Za-z]/);
            seenCommand = true;
          } else {
            expect(line.startsWith('| ')).toBe(true);
          }
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('high confidence implies a clean offline syntax check', () => {
    fc.assert(
      fc.property(splLike, (input) => {
        const r = translate(input);
        if (r.confidence === 'high') expect(checkDqlSyntax(r.dql).ok).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });

  it('never fails its own offline syntax check', () => {
    fc.assert(
      fc.property(splLike, (input) => {
        expect(translate(input).diagnostics.filter((d) => d.code === 'SPL3017')).toEqual([]);
      }),
      { numRuns: 3000 },
    );
  });
});

// Valid searches built only from commands that translate exactly.
const fieldName = fc.constantFrom('host', 'source', '_time', 'user', 'bytes');
const value = fc.constantFrom('a', 'web-01', '200', '"x y"', 'b*');
const filterTerm = fc.tuple(fieldName, fc.constantFrom('=', '!='), value).map(([f, op, v]) => `${f}${op}${v}`);
const stage = fc.oneof(
  fc.tuple(fieldName, fc.integer({ min: 1, max: 100 })).map(([f, n]) => `eval x_${n}=len(${f})`),
  fieldName.map((f) => `stats count by ${f}`),
  fc.integer({ min: 1, max: 50 }).map((n) => `head ${n}`),
  fieldName.map((f) => `dedup ${f}`),
  fieldName.map((f) => `rename ${f} AS renamed_${f.replace('_', '')}`),
);
const validSearch = fc
  .tuple(fc.array(filterTerm, { maxLength: 4 }), fc.array(stage, { maxLength: 4 }))
  .map(([terms, stages]) => [`index=web ${terms.join(' ')}`, ...stages].join(' | '));

describe('valid searches', () => {
  it('translate completely and pass the offline syntax check', () => {
    fc.assert(
      fc.property(validSearch, (spl) => {
        const r = translate(spl);
        expect(r.stages.every((s) => s.status !== 'untranslated')).toBe(true);
        expect(checkDqlSyntax(r.dql).ok).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });
});
