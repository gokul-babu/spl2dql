import {
  checkDqlSyntax,
  collectMappingNeeds,
  highlightSpl,
  InputError,
  parseCsv,
  parseCsvSearches,
  parseMappingConfig,
  parseSavedSearches,
  safeFileName,
  tokenizeDql,
  translate,
} from '@spl2dql/core';
import { describe, expect, it } from 'vitest';

/** Each search must translate without an internal error and produce DQL that passes the check. */
function ok(spl: string, contains?: string | RegExp, codes: string[] = []) {
  const r = translate(spl);
  expect(r.diagnostics.find((d) => d.code === 'SPL1008')?.message, spl).toBeUndefined();
  expect(
    checkDqlSyntax(
      r.dql
        .split('\n')
        .filter((l) => !l.startsWith('//'))
        .join('\n') || 'fetch logs',
    ).issues,
    spl,
  ).toEqual([]);
  if (contains !== undefined) expect(r.dql, spl).toMatch(contains);
  for (const c of codes)
    expect(
      r.diagnostics.map((d) => d.code),
      spl,
    ).toContain(c);
  return r;
}

describe('eval functions', () => {
  const cases: [string, string | RegExp, string[]?][] = [
    ['eval x=ltrim(a)', /not translated/, ['SPL2004']],
    ['eval x=trim(a, "x")', /not translated/, ['SPL2004']],
    ['eval x=if(a)', /not translated/, ['SPL1004']],
    ['eval x=case(a)', /not translated/, ['SPL1004']],
    ['eval x=case(a=1, "x", 1=1, "y")', 'if(a == 1, "x", else: "y")'],
    ['eval x=nullif(a)', /not translated/],
    ['eval x=isint(a), y=isstr(a), z=isbool(a)', 'type(a) == "long"', ['SPL3006']],
    ['eval x=substr(a, -5, 2), y=substr(a, -2, 5)', 'substring(a, from: -5, to: -3), y = substring(a, from: -2)'],
    ['eval x=substr(a, b)', 'substring(a, from: b - 1)', ['SPL3007']],
    ['eval x=replace(a, b, "c")', /not translated/, ['SPL2004']],
    ['eval x=replace(a, "x(\\d)", "\\1")', /not translated/, ['SPL2006']],
    ['eval x=replace(a, "(?m)^x", "y")', /not translated/, ['SPL2006']],
    ['eval x=mvindex(a, b)', /not translated/, ['SPL2004']],
    ['eval x=mvindex(a, b, c)', 'arraySlice(a, from: b, to: c + 1)', ['SPL3007']],
    ['eval x=mvindex(a, 1, 2, 3)', /not translated/],
    ['eval x=mvappend(a, b), y=mvdedup(a), z=mvsort(a)', 'arrayConcat(toArray(a), toArray(b))'],
    ['eval x=mvfilter(a > 1 AND b > 2)', /not translated/, ['SPL2004']],
    ['eval x=mvzip(a, b)', /not translated/, ['SPL2004']],
    ['eval x=tostring(a, "commas")', /not translated/, ['SPL2004']],
    ['eval x=tonumber(a, 10), y=tonumber(a)', 'toDouble(a)'],
    ['eval x=tonumber(a, 2)', /not translated/],
    ['eval x=round(a), y=round(a, -1)', 'fieldsAdd x = round(a)', ['SPL2004']],
    ['eval x=floor(a) + ceiling(a) + sqrt(a) + exp(a) + pi()', 'floor(a) + ceil(a) + sqrt(a) + exp(a) + pi()'],
    ['eval x=exact(a * 2)', 'x = a * 2'],
    ['eval x=min(a, b), r=random()', 'arrayMin(array(a, b))'],
    ['eval x=like(a, "b%")', 'like(a, "b%")'],
    ['eval x=match(a, b)', /not translated/],
    ['eval x=match(a, "x\\Bword")', /not translated/, ['SPL2006']],
    ['eval x=searchmatch("error host=a")', 'matchesPhrase(content, "error")', ['SPL3011']],
    ['eval x=searchmatch(a)', /not translated/],
    ['eval x=in(a, "b", "c")', 'in(a, {"b", "c"})'],
    ['eval x=in(a)', /not translated/],
    ['eval x=sha1(a) . sha512(a)', 'concat(hashSha1(a), hashSha512(a))'],
    ['eval x=validate(a, "x")', /not translated/],
    ['eval x=true(), y=false(), z=null(), t=time()', 'x = true, y = false, z = null, t = now()'],
    ['eval x=relative_time(_time, "+1h"), y=relative_time(_time, "@w"), z=relative_time(1700000000, "-1d")', 'timestamp + 1h'],
    ['eval x=relative_time(_time, "banana")', /not translated/],
    ['eval x=relative_time(_time, "-1bogus")', /not translated/],
    ['eval x=strftime(1700000000, "%Y")', 'timestampFromUnixSeconds(toLong(1700000000))'],
    ['eval x=strftime(_time, "%V")', /not translated/, ['SPL2004']],
    ['eval x=strptime(a, "%Y-%m-%d"), y=strptime(a, "%V")', 'x = parse(a, "TIMESTAMP(\'yyyy-MM-dd\'):t")', ['SPL2004']],
    ['eval x=strptime(a, "%Y-%m-%d")', 'parse(a, "TIMESTAMP(\'yyyy-MM-dd\'):t")', ['SPL3010']],
    // A backslash in the format is escaped like a quote, so the format cannot end the DPL literal early.
    [String.raw`eval x=strptime(a, "%d\\%m")`, String.raw`parse(a, "TIMESTAMP('dd\\\\MM'):t")`, ['SPL3010']],
    [String.raw`eval x=strptime(a, "%H\\'%M")`, String.raw`parse(a, "TIMESTAMP('HH\\'\\\\\\'\\'\\'mm'):t")`, ['SPL3010']],
    ['eval x=nosuchfunction(a)', /not translated/, ['SPL2004']],
    ['eval x=_time > 1700000000', 'unixSecondsFromTimestamp(timestamp) > 1700000000', ['SPL3006']],
    ['eval x=_time + a', 'timestamp + a * 1s'],
    ['eval x=_time - 60', 'timestamp - 60s'],
    ['eval x=-a, y=-(a+1), z=+a', 'x = -a, y = -(a + 1), z = a'],
    ['eval x=a XOR b, y=NOT a', 'a xor b'],
    ['eval x=a % 2, y=a LIKE "b%", z=a IN ("x")', 'a % 2'],
    ["eval 'my field'=1, x='my field' + 1", '`my field` = 1'],
    ['eval x="a\\"b"', 'x = "a\\"b"'],
    ['eval x=1.5e3 + .5', 'x = 1.5e3 + 0.5'],
    ['eval x=(a', /not translated/, ['SPL1004']],
    ['eval x=a $ b', /not translated/, ['SPL1004']],
    ['eval x="unterminated', /not translated/],
    ["eval x='unterminated", /not translated/],
    ['eval x=a IN b', /not translated/],
    ['eval x=f(a, ', /not translated/],
    ['eval = 1', /not translated/, ['SPL1003']],
  ];
  for (const [expr, want, codes] of cases) {
    it(expr, () => ok(`index=web | ${expr}`, want, codes ?? []));
  }
});

describe('commands and options', () => {
  const cases: [string, string | RegExp, string[]?][] = [
    ['index=web | stats partitions=2 count by host', 'summarize', ['SPL2003']],
    ['index=web | stats count by host junk', 'by:{host.name, junk}'],
    ['index=web | stats count by host | junk', /not translated/, ['SPL2001']],
    ['index=web | stats', /not translated/],
    ['index=web | stats count by host*', /not translated/, ['SPL2009']],
    ['index=web | stats avg(*)', /not translated/, ['SPL2009']],
    ['index=web | stats avg()', /not translated/, ['SPL1003']],
    ['index=web | stats upperperc95(a), stdevp(a), varp(a), rate(a), per_second(a)', 'stddev(a)', ['SPL2005', 'SPL3005']],
    ['index=web | chart count over a span=x', /not translated/],
    ['index=web | chart count over a by b c', /not translated/],
    ['index=web | chart limit=5 cont=f count over a by b', 'by:{a, b}', ['SPL3009', 'SPL2003']],
    ['index=web | chart count over', /not translated/],
    ['index=web | timechart span=2mon count', /not translated/],
    ['index=web | timechart span=1q count', 'timestamp@q'],
    ['index=web | timechart span=xx count', /not translated/],
    ['index=web | timechart bins=50 cont=f count', 'bins:50', ['SPL2003']],
    ['index=web | timechart count by host where count in top5', 'by:{host.name}', ['SPL2003']],
    ['index=web | timechart count by', /not translated/],
    ['index=web | timechart', /not translated/],
    ['index=web | timechart count junk', 'by:{timestamp = bin(timestamp, 1h)}', ['SPL2005']],
    ['index=web | top', /not translated/],
    ['index=web | top limit=0 showcount=f countfield=n percentfield=p host other=1', 'fieldsRemove n', ['SPL2003']],
    ['index=web | eventstats partitions=1 max(a)', 'join', ['SPL2003']],
    ['index=web | eventstats max(a) by b junk', 'on:{b, junk}'],
    ['index=web | timechart count | streamstats count', /not translated/, ['SPL2010']],
    ['index=web | timechart count | streamstats window=2 median(count)', /not translated/],
    ['index=web | timechart count | streamstats reset_on_change=t sum(count)', /not translated/],
    ['index=web | timechart count | streamstats sum(count) by host', /not translated/],
    ['index=web | timechart count | streamstats sum(count) as c', 'arrayCumulativeSum(count)'],
    ['index=web | timechart count | accum', /not translated/],
    ['index=web | timechart count | delta count p=2', /not translated/],
    ['index=web | timechart count | delta', /not translated/],
    ['index=web | timechart count | trendline ema5(count)', /not translated/],
    ['index=web | accum x', /not translated/, ['SPL2010']],
    ['index=web | transaction', /not translated/],
    ['index=web | bin', /not translated/],
    ['index=web | bin a', /not translated/],
    ['index=web | bin a span=x', /not translated/],
    ['index=web | bin _time span=2mon', /not translated/],
    ['index=web | bin _time span=1h aligntime=@d', 'bin(timestamp, 1h)', ['SPL2003']],
    ['index=web | table', /not translated/],
    ['index=web | stats count by host | table *', 'fields host.name, count'],
    ['index=web | fields', /not translated/],
    ['index=web | fields - _*', 'fetch', ['SPL2009']],
    ['index=web | fields - x*, y', 'fieldsRemove "x*", y'],
    ['index=web | stats count by host | fields - count', 'fieldsRemove count'],
    ['index=web | fields host, x*', 'fieldsKeep host.name, "x*"'],
    ['index=web | rename a', /not translated/],
    ['index=web | rename a AS', /not translated/],
    ['index=web | stats count by host | rename count AS n', 'fieldsRename n = count'],
    ['index=web | fillnull other=1 a', /not translated/],
    ['index=web | stats count by host | fillnull value=0 c*', 'coalesce(count, 0)'],
    ['index=web | replace a WITH', /not translated/],
    ['index=web | replace a b', /not translated/],
    ['index=web | replace a* WITH b IN c', /not translated/],
    ['index=web | replace a WITH b IN c*', /not translated/],
    ['index=web | replace a WITH b', /not translated/],
    ['index=web | convert timeformat="%Y" ctime(a) dur2sec(b)', /not translated/],
    ['index=web | convert junk=1 ctime(a)', /not translated/],
    ['index=web | convert timeformat="%V" ctime(a)', /not translated/],
    ['index=web | convert ctime(a) AS', /not translated/],
    ['index=web | convert none(a), auto(b) AS c', 'c = toDouble(b)'],
    ['index=web | convert', 'fetch'],
    ['index=web | convert junk', /not translated/],
    ['index=web | addtotals row=t col=f a', 'Total = coalesce(a, 0)'],
    ['index=web | addtotals col=t a', /not translated/],
    ['index=web | foreach', /not translated/],
    ['index=web | foreach a [stats count]', /not translated/],
    ['index=web | foreach a [eval x]', /not translated/],
    ['index=web | foreach a [eval x=(]', /not translated/],
    ['index=web | foreach x* [eval <<FIELD>>=1]', /not translated/],
    ['index=web | stats count by host | foreach c* [eval <<MATCHSTR>>_x = <<FIELD>> + 1]', 'ount_x = count + 1'],
    ['index=web | makemv tokenizer="(\\w+)" a', /not translated/],
    ['index=web | makemv allowempty=t a', 'splitString(a, " ")'],
    ['index=web | makemv', /not translated/],
    ['index=web | mvexpand', /not translated/],
    ['index=web | mvexpand a junk=1', /not translated/],
    ['index=web | nomv', /not translated/],
    ['index=web | mvcombine a', /not translated/],
    ['index=web | stats count by a | mvcombine junk=1 a', /not translated/],
    ['index=web | mvcombine', /not translated/],
    ['index=web | rangemap field=a low=x', /not translated/],
    ['index=web | rangemap low=1-2', /not translated/],
    ['index=web | sort limit=5 a', 'limit 5'],
    ['index=web | sort junk=5 a', /not translated/],
    ['index=web | sort str(a), ip(b), auto(c)', 'toString(a) asc, toIp(b) asc, c asc'],
    ['index=web | sort num(a', /not translated/],
    ['index=web | sort', /not translated/],
    ['index=web | sort +a', 'sort a asc'],
    ['index=web | head limit=3', 'limit 3'],
    ['index=web | head junk=3', /not translated/],
    ['index=web | dedup consecutive=t a', /not translated/],
    ['index=web | dedup consecutive=f keepevents=f a', 'dedup a'],
    ['index=web | dedup junk=1 a', /not translated/],
    ['index=web | dedup', /not translated/],
    ['index=web | dedup a*', /not translated/],
    ['index=web | dedup a sortby +b, c', 'sort:{b asc, c asc}'],
    ['index=web | uniq', /not translated/],
    ['index=web | stats count by a | reverse', /not translated/],
    ['index=web | return', /not translated/],
    ['index=web | return 2 user', 'limit 2'],
    ['index=web | rex', /not translated/],
    ['index=web | rex "a" "b"', /not translated/],
    ['index=web | rex "no named groups"', /not translated/],
    ['index=web | rex mode=sed "y/a/b/"', /not translated/],
    ['index=web | rex mode=sed "s/a/\\1/g"', /not translated/],
    ['index=web | rex mode=sed "s/(?m)a/b/g"', /not translated/],
    ['index=web | rex mode=sed "s/a/b/"', 'replaceString', ['SPL3008']],
    ['index=web | rex max_match=1 field=a "x=(?<x>\\d+)"', 'LONG:x'],
    ['index=web | spath input=_raw output=o junk=1', /not translated/],
    ['index=web | spath user.id', 'jsonPath(content, "$.user.id")'],
    ['index=web | spath a b', /not translated/],
    ['index=web | regex', /not translated/],
    ['index=web | lookup', /not translated/],
    ['index=web | lookup t', /not translated/],
    ['index=web | lookup t a b OUTPUT c AS d', 'join [load "/lookups/t"], on:{a, b}, kind:leftOuter, fields:{d = c}'],
    ['index=web | lookup t a b', 'join', ['SPL3016']],
    ['index=web | lookup t a OUTPUT', 'lookup'],
    ['index=web | lookup t a AS b OUTPUT c AS d', 'fields:{d = c}'],
    ['| inputlookup', /not translated/],
    ['| inputlookup junk=1 t', /not translated/],
    ['| inputlookup t junk', /not translated/],
    ['| inputlookup t where (', /not translated/],
    ['index=web | inputlookup append=t t where a=1', /not translated/],
    ['index=web | join type=bogus a [search index=b]', /not translated/],
    ['index=web | join left=L a [search index=b]', /not translated/],
    ['index=web | join max=0 overwrite=t a [search index=b]', 'join', ['SPL2003']],
    ['index=web | join a', /not translated/],
    ['index=web | join [search index=b]', /not translated/],
    ['index=web | append', /not translated/],
    ['index=web | append extendtimerange=t [search index=b]', 'append'],
    ['| union', /not translated/],
    ['index=web | union [search index=b]', 'append [fetch logs'],
    ['| makeresults annotate=t', /not translated/],
    ['| tstats append=t count', /not translated/],
    ['| tstats count where index=a by _time', 'bin(timestamp, 1h)', ['SPL3003']],
    ['| tstats count where index=a by _time span=x', /not translated/],
    ['| tstats count junk', 'summarize count = count()', ['SPL2005']],
    ['| tstats mode(a)', /not translated/],
    ['| tstats count where (', /not translated/],
    ['| mstats junk=1 avg(m)', /not translated/],
    ['| mstats avg(m) WHERE (', /not translated/],
    ['| mstats avg(m) span=x', /not translated/],
    ['| mstats avg(m) junk=1', /not translated/],
    ['| mstats avg(m) junk', /not translated/],
    ['| mstats count', /not translated/],
    ['| mstats mode(m)', /not translated/],
    ['| mstats perc95(m) as p', 'percentile(m, 95)'],
    ['| mstats avg(a), max(b) BY host span=1h', '{`avg(a)` = avg(a), `max(b)` = max(b)}'],
    ['index=web | search earliest=-1h', 'fetch', ['SPL2003']],
    ['index=web | search a=1 | search earliest=-1h a=2', 'filter', ['SPL2003']],
    ['index=web | stats count by host | search (a OR web)', /not translated/],
    ['index=web | stats count by host | search NOT b=1', 'filterOut'],
    ['index=web | search index=web', 'dt.system.bucket'],
    ['index=web | where', /not translated/],
    ['index=web | `my`', /not translated/],
    ['index=web a=b NOT c!=d e!=* f>=g h<"i"', 'filterOut not matchesValue(c, "d")', ['SPL3002']],
    ['index=a index=b', 'fetch logs'],
    ['index=a OR index=* | head 1', 'fetch logs'],
    ['index=web latest="13/45/2026:00:00:00"', 'fetch', ['SPL3015']],
    ['index=web earliest=@mon latest=+1d', 'from:@M, to:+1d'],
    ['index=web earliest=-1mon-2h', 'fetch', ['SPL3015']],
    ['index=web earliest=@x', 'fetch', ['SPL3015']],
    ['index=web earliest=-1x', 'fetch', ['SPL3015']],
    ['index=web earliest=""', 'fetch', ['SPL3015']],
    ['index=web _index_earliest=-1h', 'fetch', ['SPL2011']],
    ['index=web (earliest=-1h OR a=1)', /not translated/],
    ['index=web sourcetype!=x OR tag=y', 'fetch'],
    ['index=web eventtype=e OR a', 'fetch', ['SPL4006']],
    ['index=web "a" CASE(b) TERM(c) d IN ("e") f IN ()', 'matchesValue'],
    ['index=web a = "b c" d >= 5', 'matchesValue(a, "b c") and d >= 5'],
    ['index=web a !=b', 'not matchesValue(a, "b")'],
    ['index=web AND', /not translated/],
    ['index=web ()', /not translated/],
    ['index=web a)', /not translated/],
    ['index=web [', /not translated/],
    ['index=web a IN (b c', /not translated/],
  ];
  for (const [spl, want, codes] of cases) {
    it(spl, () => ok(spl, want, codes ?? []));
  }
});

describe('mapping-driven paths', () => {
  const mapping = parseMappingConfig({
    version: 1,
    defaults: { dataObject: 'logs', timeframe: '-2h', timezone: '+02:00' },
    indexes: { web: { buckets: ['w'], filter: 'k == "x"' }, ev: { dataObject: 'events' }, 'l*': { buckets: ['l1'] }, 'lo*': { buckets: ['l2'] } },
    sourcetypes: { st: { filter: 'a == 1', extractions: ['x'] } },
    fields: { level: 'loglevel', n: 'num' },
    fieldTypes: { num: 'number', s: 'string', t: 'time' },
    lookups: { t: { path: '/lookups/t', key: 'k', columns: ['k', 'v'] } },
    tags: { tg: 'b == 2' },
    metrics: { m: 'dt.m' },
    macros: { 'm(2)': { args: ['a', 'b'], definition: '$a$=$b$' }, inner: { definition: '`missing`' }, outer: { definition: '`inner` x=1' } },
  });
  if (!mapping.ok) throw new Error(JSON.stringify(mapping.issues));
  const m = mapping.value;
  const cases: [string, string | RegExp, string[]?][] = [
    ['index=web', 'fetch logs, bucket:{"w"}, from:-2h\n| filter k == "x"'],
    ['index=web OR index=ev', /not translated/, ['SPL2003']],
    ['index=long', 'bucket:{"l2"}'],
    ['index=web sourcetype=st NOT sourcetype=st tag=tg', 'filter (k == "x") and (a == 1) and (b == 2)'],
    ['index=web num IN (1, 2) s=5 num!=3', 'in(num, {1, 2})'],
    ['index=web earliest="10/27/2026:10:00:00"', 'from:"2026-10-27T08:00:00Z"'],
    ['index=web `m(level, ERROR)`', 'matchesValue(loglevel, "ERROR")'],
    ['index=web `outer`', 'fetch', ['SPL1005']],
    ['index=web | lookup t k', 'fields:{v}'],
    ['| mstats avg(m)', 'avg(dt.m)'],
    ['index=web | eval y=t + 1', 'y = t + 1s'],
    ['index=web | sort t', 'sort t asc'],
    ['index=web | eval x=strftime(t, "%H")', 'formatTimestamp(t, format: "HH")'],
  ];
  for (const [spl, want, codes] of cases) {
    it(spl, () => {
      const r = translate(spl, { mapping: m });
      expect(r.diagnostics.find((d) => d.code === 'SPL1008')).toBeUndefined();
      expect(r.dql).toMatch(want);
      for (const c of codes ?? []) expect(r.diagnostics.map((d) => d.code)).toContain(c);
    });
  }
});

describe('input file parsers', () => {
  it('reads savedsearches.conf with continuation lines', () => {
    const s = parseSavedSearches('# comment\n[a]\nsearch = x \\\n| y\n[b]\ndescription = no search\n[c]\nsearch =\n', 'f');
    expect(s).toEqual([{ name: 'a', spl: 'x \n| y', origin: 'f › a' }]);
  });
  it('reads CSV with quotes, CRLF and a title column', () => {
    expect(parseCsv('a,b\r\n"x,""y""",z\n')).toEqual([
      ['a', 'b'],
      ['x,"y"', 'z'],
    ]);
    expect(parseCsvSearches('title,search\nT,"index=a"\n,\n', 'f')).toEqual([{ name: 'T', spl: 'index=a', origin: 'f › row 2' }]);
    expect(parseCsvSearches('search\nindex=a\n', 'f')[0]?.name).toBe('row-2');
    expect(() => parseCsvSearches('name\nx\n', 'f')).toThrow(InputError);
  });
  it('makes safe, unique file names', () => {
    const taken = new Set<string>();
    expect(safeFileName('../../etc/passwd', taken)).toBe('etc_passwd');
    expect(safeFileName('CON', taken)).toBe('_CON');
    expect(safeFileName('a b', taken)).toBe('a_b');
    expect(safeFileName('a b', taken)).toBe('a_b-2');
    expect(safeFileName('...', taken)).toBe('search');
    expect(safeFileName('x'.repeat(300), taken)).toHaveLength(100);
  });
});

describe('highlighting, lexing and needs', () => {
  it('highlights every token kind', () => {
    const types = new Set(
      highlightSpl('| makeresults ```c``` `m` [search a] x="s" 5 | eval y=f(x) AND NOT z>1 | where a LIKE "b" | rex "\\"" | x |').map((t) => t.type),
    );
    for (const t of ['command', 'comment', 'macro', 'bracket', 'string', 'number', 'function', 'keyword', 'operator', 'pipe', 'option'])
      expect(types.has(t as never), t).toBe(true);
  });
  it('lexes durations, exponents, alignments and errors', () => {
    const t = tokenizeDql('1.5e3 2e 5ms @d @ "x\\"y" """a"b""" \'q\' `b` # ~ 😀 "open');
    expect(t.map((x) => x.type)).toEqual([
      'number',
      'number',
      'ident',
      'duration',
      'align',
      'error',
      'string',
      'string',
      'string',
      'backtick',
      'error',
      'error',
      'error',
      'error',
      'eof',
    ]);
  });
  it('collects every kind of mapping need', () => {
    const r = translate('index=web eventtype=e | stats count by sourcetype | mstats avg(m)');
    const needs = collectMappingNeeds([
      ...r.diagnostics,
      { code: 'SPL4002', severity: 'warning', message: '', span: { start: 0, end: 0 }, stageIndex: 0, subject: 'sourcetype=st' },
      { code: 'SPL4007', severity: 'warning', message: '', span: { start: 0, end: 0 }, stageIndex: 0, subject: 'm' },
    ]);
    expect(needs.eventtypes).toEqual(['eventtype=e']);
    expect(needs.sourcetypes).toEqual(['st']);
    expect(needs.metrics).toEqual(['m']);
  });
});
