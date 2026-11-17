import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allDiagnosticDocs,
  checkDqlExpression,
  checkDqlSyntax,
  collectMappingNeeds,
  explainDiagnostic,
  highlightSpl,
  listCommands,
  parseMappingConfig,
  regexToDpl,
  tokenizeDql,
  translate,
} from '@spl2dql/core';
import { describe, expect, it } from 'vitest';
import { DQL_COMMANDS, DQL_FUNCTIONS } from '../src/dql/catalog.generated.ts';
import { printQuery, quote, UnprintableName } from '../src/dql/printer.ts';
import { strftimeToDql } from '../src/lower/strftime.ts';
import { parseTimeModifier } from '../src/spl/time.ts';

describe('DQL parser and offline check', () => {
  it('accepts the forms the translator emits', () => {
    for (const q of [
      'fetch logs, bucket:{"web_logs"}, from:-24h@h, to:-1h@h',
      'fetch logs | filter matchesValue(http.method, {"GET", "POST"}) and not (a == 1)',
      'fetch logs | summarize {a = count(), `max(x)` = max(x)}, by:{host.name, timestamp = bin(timestamp, 5m)}',
      'fetch logs | makeTimeseries count = count(default: 0), by:{host.name}, interval:5m',
      'fetch logs | sort count desc, b asc | limit 10',
      'fetch logs | dedup host.name, sort:{timestamp desc}',
      'fetch logs | fields x = _r[`host.name`], y = 100.0 * _r[count] / _total',
      'fetch logs | join [fetch logs | summarize a = avg(x), by:{k}], on:{k}, kind:leftOuter, fields:{a}',
      'fetch logs | filter user.name in [fetch logs | fields user.name]',
      'data record(timestamp = now())',
      'fetch logs | fieldsAdd start = (now() - 1d)@d, t = timestamp@M',
      'fetch logs, from:now()-1d@d+2h',
      'fetch logs // comment\n| limit 1',
    ]) {
      expect(checkDqlSyntax(q).issues, q).toEqual([]);
    }
  });

  it('reports unknown commands, functions and parameters with positions', () => {
    const r = checkDqlSyntax('fetch logs | fliter x == 1 | summarize count(), by2:{x} | fieldsAdd y = nope(1), z = round(1, digits: 2)');
    expect(r.ok).toBe(false);
    const messages = r.issues.map((i) => i.message);
    expect(messages).toContain('Unknown command "fliter".');
    expect(messages).toContain('Unknown function "nope".');
    expect(messages).toContain('"round" has no parameter "digits".');
    expect(messages).toContain('"summarize" has no parameter "by2".');
    for (const i of r.issues) expect(i.span.start).toBeGreaterThan(0);
  });

  it('reports syntax errors', () => {
    for (const q of ['fetch logs | filter (a', 'fetch logs | filter "abc', 'fetch logs |', '', 'fetch logs | filter a ==', 'fetch logs | limit 1 2']) {
      expect(checkDqlSyntax(q).ok, q).toBe(false);
    }
  });

  it('checks single expressions and refuses pipes in them', () => {
    expect(checkDqlExpression('a == 1 and b != "x"').ok).toBe(true);
    expect(checkDqlExpression('a == 1 | fetch logs').ok).toBe(false);
    expect(checkDqlExpression('').ok).toBe(false);
  });

  it('survives hostile nesting', () => {
    expect(checkDqlSyntax(`fetch logs | filter ${'('.repeat(5000)}a${')'.repeat(5000)}`).ok).toBe(false);
    expect(checkDqlSyntax(`fetch logs | filter ${'not '.repeat(5000)}a`).ok).toBe(false);
  });

  it('tokenizes without throwing on any input', () => {
    expect(tokenizeDql('"unterminated').some((t) => t.type === 'error')).toBe(true);
    expect(tokenizeDql('a\u0000b😀').length).toBeGreaterThan(0);
  });
});

describe('printer', () => {
  it('escapes strings', () => {
    expect(quote('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
  });

  it('keeps comments on one line so text after a newline cannot become DQL', () => {
    const out = printQuery({ commands: [{ name: '//', args: [], origin: [0], comment: 'x\n| fetch secrets | y' }] });
    expect(out.text.split('\n')).toHaveLength(1);
  });

  it('backticks unusual field names', () => {
    const out = printQuery({
      commands: [{ name: 'fields', args: [{ kind: 'pos', value: { k: 'field', name: 'a b' } }], origin: [0] }],
    });
    expect(out.text).toBe('fields `a b`');
  });

  // ADR-029: no source confirms an escape for a backtick inside a backticked name, so such a name
  // (or one with CR/LF) is never printed; the stage that holds it is not translated (SPL2012).
  it('refuses to print a field name with a backtick, CR or LF', () => {
    for (const name of ['a`b c', 'a\rb', 'a\nb']) {
      expect(() => printQuery({ commands: [{ name: 'fields', args: [{ kind: 'pos', value: { k: 'field', name } }], origin: [0] }] })).toThrow(UnprintableName);
    }
  });

  it('never lets a field name break out of the query', () => {
    const r = translate("index=web | eval 'x` | fetch secret | `'=1");
    expect(r.dql.split('\n').filter((l) => l.startsWith('| fetch'))).toEqual([]);
  });
});

describe('regex → Dynatrace pattern', () => {
  const cases: [string, string | null][] = [
    ['user=(?<u>\\w+)', "DATA? 'user=' [a-zA-Z0-9_]+:u"],
    ['^(?<n>\\d+)$', 'LONG:n EOS'],
    ['(?<x>-?\\d+\\.\\d+)', 'DATA? DOUBLE:x'],
    ['(?<host_name>\\S+)', "DATA? NSPACE:'host_name'"],
    ['a.*b', "DATA? 'a' LD 'b'"],
    ['(?:GET|POST) /', "DATA? ('GET' | 'POST') ' /'"],
    ["it's", "DATA? 'it\\'s'"],
    ['x\\d{2,4}', "DATA? 'x' [0-9]{2,4}"],
    ['(a)\\1', null],
    ['(?i)abc', 'DATA? [aA] [bB] [cC]'],
    ['(?i)[a-f0-9]+x', 'DATA? [a-f0-9A-F]+ [xX]'],
    ['(?s)a.*b', "DATA? 'a' DATA 'b'"],
    ['(?m)^a', null],
    ['(?i:a)b', null],
    ['a(?=b)', "DATA? 'a' >>'b'"],
    ['a(?!bc)', "DATA? 'a' !>>'bc'"],
    ['(?<=id=)(?<n>\\d+)', "DATA? <<'id=' LONG:n"],
    ['\\bword\\b', "DATA? !<<[a-zA-Z0-9_] 'word' !>>[a-zA-Z0-9_]"],
    ['\\b\\.x', null],
    ['x\\Bword', null],
    ['(?<v>v\\d+)', "DATA? ('v' [0-9]+):v"],
    ['(?<m>GET|POST) ', "DATA? ('GET' | 'POST'):m ' '"],
    ['(?<o>\\d+)?x', "DATA? LONG?:o 'x'"],
    ['(?:ab){2}c', "DATA? 'ab' 'ab' 'c'"],
    ['(?:ab)+', null],
    ['(?:a|b\\d)c', "DATA? ('a' | ('b' [0-9])) 'c'"],
    ['[\\d.]+', 'DATA? [0-9.]+'],
    ['[\\D]+', null],
    ['(?<n>a.*b)c', null],
    ['a|b', "DATA? ('a' | 'b')"],
    ['[a|b]+c', "DATA? [a|b]+ 'c'"],
    ['^a|b', null],
    ['a|b$', null],
    ['a|(?<n>b)', "DATA? ('a' | ('b'):n)"],
    ['a|\\d+', "DATA? ('a' | [0-9]+)"],
    ['a.b', null],
    ['(?<n>a)+', null],
    ['[a', null],
  ];
  for (const [re, want] of cases) {
    it(re, () => {
      const r = regexToDpl(re, { captures: true });
      if (want === null) expect(r.ok).toBe(false);
      else expect(r.ok && r.dpl).toBe(want);
    });
  }
});

describe('time modifiers', () => {
  it('converts relative and absolute times', () => {
    expect(parseTimeModifier('-24h@h', 'UTC')).toEqual({ kind: 'relative', dql: '-24h@h', exact: true });
    expect(parseTimeModifier('-1d-2h', 'UTC')).toEqual({ kind: 'relative', dql: '-26h', exact: true });
    expect(parseTimeModifier('@w3', 'UTC')).toEqual({ kind: 'relative', dql: '@w3', exact: true });
    expect(parseTimeModifier('-1mon-2d', 'UTC').kind).toBe('invalid');
    expect(parseTimeModifier('10/27/2026:10:00:00', '+02:00')).toEqual({ kind: 'absolute', iso: '2026-10-27T08:00:00Z', fromText: true });
    expect(parseTimeModifier('01/15/2026:12:00:00', 'Europe/Vienna')).toEqual({ kind: 'absolute', iso: '2026-01-15T11:00:00Z', fromText: true });
    expect(parseTimeModifier('07/15/2026:12:00:00', 'Europe/Vienna')).toEqual({ kind: 'absolute', iso: '2026-07-15T10:00:00Z', fromText: true });
    expect(parseTimeModifier('banana', 'UTC').kind).toBe('invalid');
  });
  it('maps strftime directives', () => {
    expect(strftimeToDql('%Y-%m-%dT%H:%M:%S.%3N%z')).toEqual({ ok: true, format: "yyyy-MM-dd'T'HH:mm:ss.SSSZ" });
    expect(strftimeToDql('%V')).toEqual({ ok: false, directive: '%V' });
  });
});

describe('mapping file validation', () => {
  it('accepts a full mapping', () => {
    const r = parseMappingConfig({
      version: 1,
      defaults: { dataObject: 'logs', timeframe: '-24h', timezone: 'Europe/Berlin' },
      indexes: { web: { buckets: ['web_logs'], filter: 'k8s.namespace.name == "web"' } },
      fields: { level: 'loglevel' },
      fieldTypes: { 'http.status': 'number' },
      macros: { 'm(1)': { args: ['x'], definition: 'host=$x$' } },
      lookups: { t: { path: '/lookups/t', columns: ['a'] } },
    });
    expect(r.ok).toBe(true);
  });

  it('reports every problem with a JSON pointer', () => {
    const r = parseMappingConfig({
      version: 2,
      typo: 1,
      defaults: { timezone: 'Mars/Base' },
      indexes: { web: { buckets: ['bad bucket'], filter: 'a == | fetch secrets' } },
      fields: { level: 'has`backtick' },
      fieldTypes: { x: 'float' },
      macros: { 'm(2)': { args: ['a'], definition: 'x' } },
      lookups: { t: { path: '/etc/passwd' }, u: { path: '/lookups/../secret' } },
      eventtypes: { e: 'not ( valid' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.issues.map((i) => i.path);
    for (const p of [
      '/version',
      '/typo',
      '/defaults/timezone',
      '/indexes/web/buckets/0',
      '/indexes/web/filter',
      '/fields/level',
      '/fieldTypes/x',
      '/macros/m(2)',
      '/lookups/t/path',
      '/lookups/u/path',
      '/eventtypes/e',
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it('rejects non-objects without throwing', () => {
    for (const x of [null, 1, 'x', [], undefined, new Date()]) expect(parseMappingConfig(x).ok).toBe(false);
  });
});

describe('registry and catalogue', () => {
  it('lists every command once, alphabetically', () => {
    const list = listCommands();
    const names = list.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    expect(list.length).toBeGreaterThan(80);
  });

  it('explains every diagnostic code', () => {
    for (const d of allDiagnosticDocs()) {
      expect(explainDiagnostic(d.code.toLowerCase())?.hint.length).toBeGreaterThan(0);
    }
    expect(explainDiagnostic('SPL9999')).toBeUndefined();
  });

  it('only emits DQL commands and functions that exist in the reference', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.ts') && !e.name.includes('generated')) files.push(join(dir, e.name));
      }
    };
    walk(srcDir);
    const fns = new Set<string>();
    const cmds = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bcall\('([A-Za-z0-9]+)'/g)) fns.add(m[1] as string);
      for (const m of text.matchAll(/\bcmd\('([A-Za-z]+)'/g)) cmds.add(m[1] as string);
    }
    const missingFns = [...fns].filter((f) => !Object.hasOwn(DQL_FUNCTIONS, f));
    const missingCmds = [...cmds].filter((c) => !Object.hasOwn(DQL_COMMANDS, c));
    expect(missingFns).toEqual([]);
    expect(missingCmds).toEqual([]);
    expect(fns.size).toBeGreaterThan(50);
  });
});

describe('highlighting and mapping needs', () => {
  it('highlights commands, keywords, strings and pipes', () => {
    const t = highlightSpl('index=web "x" | stats count by host | eval y=len(x)');
    const types = new Set(t.map((x) => x.type));
    for (const want of ['command', 'string', 'pipe', 'keyword', 'function', 'option']) expect(types.has(want as never), want).toBe(true);
  });

  it('collects unresolved names for a mapping skeleton', () => {
    const r = translate('index=web sourcetype=st `m` | lookup geo ip | stats count by uri');
    const needs = collectMappingNeeds(r.diagnostics);
    expect(needs.indexes).toEqual(['web']);
    expect(needs.sourcetypes).toEqual(['st']);
    expect(needs.macros).toEqual(['m']);
    expect(needs.lookups).toEqual(['geo']);
    expect(needs.fields).toEqual(['ip', 'uri']);
  });
});
