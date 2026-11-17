import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkDqlSyntax,
  convertDashboard,
  convertDashboardSource,
  type DashboardConversion,
  DashboardError,
  importSplunkConfig,
  mergeMappingSections,
  parseConf,
  parseMappingConfig,
  parseSavedSearches,
  readDashboard,
  translate,
  translateCondition,
} from '@spl2dql/core';
import { describe, expect, it } from 'vitest';
import { parseXml, XmlError } from '../src/dashboard/xml.ts';
import { nameGroups } from '../src/io/splunk-config.ts';

const app = fileURLToPath(new URL('../../../examples/splunk-app/', import.meta.url));
const read = (path: string): string => readFileSync(app + path, 'utf8');
const conf = (name: string) => ({ name: `default/${name}`, text: read(`default/${name}`) });
const view = (name: string) => ({ name, text: read(`default/data/ui/views/${name}`) });

function mapping(data: Record<string, unknown>) {
  const parsed = parseMappingConfig({ version: 1, ...data });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

describe('Splunk .conf files', () => {
  it('reads stanzas, continuation lines, comments and repeated keys', () => {
    const stanzas = parseConf('top = 1\n# a comment\n[a]\nk = one \\\n  two\nk2=v\n[b]\n\n[a]\nk2 = later\nnot a pair\n');
    expect(stanzas.map((s) => s.name)).toEqual(['default', 'a', 'b']);
    expect(stanzas[0]?.values.get('top')).toBe('1');
    expect(stanzas[1]?.values.get('k')).toBe('one \n  two');
    expect(stanzas[1]?.values.get('k2')).toBe('later');
    expect(stanzas[2]?.values.size).toBe(0);
  });

  it('keeps the saved time range, the schedule and the disabled flag of a saved search', () => {
    const searches = parseSavedSearches(read('default/savedsearches.conf'), 'f');
    expect(searches).toHaveLength(9);
    const slow = searches.find((s) => s.name === 'Web - slow requests');
    expect(slow).toMatchObject({ earliest: '-60m@m', latest: 'now', schedule: '*/15 * * * *' });
    // [default] supplies the range a stanza does not set.
    expect(searches.find((s) => s.name === 'Web - error rate by host')).toMatchObject({
      earliest: '-24h@h',
      latest: 'now',
      description: 'Share of server errors per host',
    });
    expect(searches.find((s) => s.name === 'Old weekly report')?.disabled).toBe(true);
    expect(slow?.disabled).toBeUndefined();
    expect(parseSavedSearches('[x]\nsearch = a\ncron_schedule = 0 * * * *\nenableSched = 0\n', 'f')[0]?.schedule).toBeUndefined();
  });

  it('carries macros over, and says why an eval-based one is left out', () => {
    const r = importSplunkConfig([conf('macros.conf')]);
    expect(Object.keys(r.sections.macros ?? {})).toEqual(['web_index', 'security_content_summariesonly', 'security_content_ctime(1)']);
    expect(r.sections.macros?.['security_content_ctime(1)']).toEqual({ args: ['field'], definition: 'convert timeformat="%Y-%m-%dT%H:%M:%S" ctime($field$)' });
    expect(r.skipped).toEqual([{ section: 'macros', name: 'business_hours', reason: expect.stringContaining('eval-based macro') }]);
    const bad = importSplunkConfig([{ name: 'macros.conf', text: '[m(2)]\nargs = a\ndefinition = x\n[n]\n[bad name]\ndefinition = y\n' }]);
    expect(bad.counts.macros).toBe(0);
    expect(bad.skipped.map((s) => s.name)).toEqual(['m(2)', 'n', 'bad name']);
  });

  it('a later file overrides an earlier one, as local/ overrides default/', () => {
    const r = importSplunkConfig([
      { name: 'default/macros.conf', text: '[idx]\ndefinition = index=a\n' },
      { name: 'local/macros.conf', text: '[idx]\ndefinition = index=b\n' },
    ]);
    expect(r.sections.macros?.idx?.definition).toBe('index=b');
  });

  it('turns EXTRACT and REPORT definitions into parse patterns', () => {
    const r = importSplunkConfig([conf('props.conf'), conf('transforms.conf')]);
    const ex = r.sections.extractions ?? {};
    expect(Object.keys(ex).sort()).toEqual(['bytes', 'method', 'pid', 'src_ip', 'src_port', 'status', 'uri', 'user']);
    expect(ex.user?.dpl).toBe(
      "DATA? 'Failed password for ' ('invalid user ')? NSPACE:user ' from ' ([0-9]+ '.' [0-9]+ '.' [0-9]+ '.' [0-9]+):'src_ip' ' port ' LONG:'src_port'",
    );
    expect(ex.src_ip).toEqual(ex.user);
    expect(ex.pid).toEqual({ from: 'content', dpl: "DATA? 'sshd[' LONG:pid ']'" });
    expect(r.skipped).toEqual([{ section: 'extractions', name: '[linux_secure] REPORT-sshd → sshd_csv', reason: expect.stringContaining('delimiters') }]);
  });

  it('reads the source field of an extraction and refuses what it cannot convert', () => {
    const r = importSplunkConfig([
      {
        name: 'props.conf',
        text: '[st]\nEXTRACT-a = id=(?<id>\\d+) in uri\nEXTRACT-b = (?<x>a.*b)c\nEXTRACT-c = no group here\nREPORT-d = missing, dyn\nEXTRACT-e = id=(?<id>\\w+)\n',
      },
      { name: 'transforms.conf', text: '[dyn]\nREGEX = (\\w+)=(\\w+)\nFORMAT = $1::$2\n' },
    ]);
    expect(r.sections.extractions).toEqual({ id: { from: 'uri', dpl: "DATA? 'id=' LONG:id" } });
    expect(r.skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('".*" in the middle'),
      expect.stringContaining('no named group'),
      expect.stringContaining('not in the transforms.conf'),
      expect.stringContaining('$1::$2'),
      expect.stringContaining('the first one was kept'),
    ]);
  });

  it('names numbered groups from FORMAT', () => {
    expect(nameGroups('sshd\\[(\\d+)\\]', 'pid::$1')).toBe('sshd\\[(?<pid>\\d+)\\]');
    expect(nameGroups('(a)(?:b)(c)[(](d)', 'x::$1 y::$3')).toBe('(?<x>a)(?:b)(?:c)[(](?<y>d)');
    expect(nameGroups('(?<n>a)(b)', 'second::$2')).toBe('(?<n>a)(?<second>b)');
    expect(nameGroups('(a)', undefined)).toBe('(a)');
    expect(nameGroups('(a)=(b)', '$1::$2')).toBeUndefined();
  });

  it('translates eventtypes to conditions and joins tags with "or"', () => {
    const r = importSplunkConfig([conf('eventtypes.conf'), conf('tags.conf')]);
    expect(r.sections.eventtypes).toEqual({
      failed_ssh: 'matchesPhrase(content, "Failed password")',
      sudo_session: 'matchesPhrase(content, "sudo:") and matchesPhrase(content, "session opened")',
    });
    expect(r.sections.tags?.failure).toBe('matchesPhrase(content, "Failed password")');
    expect(r.sections.tags?.privileged).toBe(
      '(matchesPhrase(content, "sudo:") and matchesPhrase(content, "session opened")) or (matchesValue(host.name, "bastion-01"))',
    );
    // Every condition is DQL the mapping file accepts.
    expect(parseMappingConfig(mergeMappingSections({ version: 1 }, r.sections)).ok).toBe(true);
  });

  it('leaves out an eventtype that is more than a filter, and every tag that depends on it', () => {
    const r = importSplunkConfig([
      { name: 'eventtypes.conf', text: '[ok]\nsearch = level=ERROR\n[piped]\nsearch = index=a | stats count\n[empty]\n[off]\ndisabled = 1\nsearch = x\n' },
      { name: 'tags.conf', text: '[eventtype=ok]\ngood = enabled\nmixed = enabled\nunused = disabled\n[eventtype=piped]\nmixed = enabled\n' },
    ]);
    expect(Object.keys(r.sections.eventtypes ?? {})).toEqual(['ok']);
    expect(r.sections.tags).toEqual({ good: 'matchesValue(level, "ERROR")' });
    expect(r.skipped.map((s) => `${s.section}:${s.name}`)).toEqual(['eventtypes:piped', 'eventtypes:empty', 'tags:mixed']);
  });

  it('the mapping file wins over imported definitions', () => {
    const merged = mergeMappingSections(
      { version: 1, macros: { web_index: { definition: 'index=mine' } } },
      importSplunkConfig([conf('macros.conf')]).sections,
    );
    const macros = merged.macros as Record<string, { definition: string }>;
    expect(macros.web_index?.definition).toBe('index=mine');
    expect(Object.keys(macros)).toHaveLength(3);
  });

  it('a search expression becomes one condition only when it is a pure filter', () => {
    expect(translateCondition('status>=500 NOT uri="/health*"').condition).toBe('status >= 500 and not matchesValue(uri, "/health*")');
    expect(translateCondition('index=web error', { mapping: mapping({ indexes: { web: { buckets: ['web_logs'] } } }) }).condition).toBe(
      'in(dt.system.bucket, {"web_logs"}) and matchesPhrase(content, "error")',
    );
    for (const not of ['index=a | stats count', '', '| makeresults', 'a [search b | fields c]', 'x | rex "("'])
      expect(translateCondition(not).condition, not).toBeUndefined();
  });

  it('survives names that would pollute a plain object', () => {
    const r = importSplunkConfig([
      { name: 'macros.conf', text: '[__proto__]\ndefinition = x\n[constructor]\ndefinition = y\n' },
      { name: 'props.conf', text: '[s]\nEXTRACT-p = (?<__proto__>\\d+)\n' },
      { name: 'tags.conf', text: '[host=a]\n__proto__ = enabled\n' },
    ]);
    expect(Object.keys(r.sections.macros ?? {})).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).definition).toBeUndefined();
    expect(Object.hasOwn(r.sections.extractions ?? {}, '__proto__')).toBe(true);
  });
});

describe('extractions from the mapping file', () => {
  const m = mapping({
    extractions: {
      user: { from: 'content', dpl: "DATA? 'user=' NSPACE:user ' ip=' NSPACE:ip" },
      ip: { from: 'content', dpl: "DATA? 'user=' NSPACE:user ' ip=' NSPACE:ip" },
    },
    datamodels: { Authentication: { fields: {} } },
  });

  it('come after fetch, once per pattern, and keep existing values where the pattern does not match', () => {
    expect(translate('user=alice | stats count by ip', { mapping: m }).dql).toBe(
      [
        'fetch logs',
        `| parse content, "DATA? 'user=' NSPACE:user ' ip=' NSPACE:ip", preserveFieldsOnFailure:true`,
        '| filter matchesValue(user, "alice")',
        '| filter isNotNull(ip)',
        '| summarize count = count(), by:{ip}',
      ].join('\n'),
    );
  });

  it('are not applied to a data model, whose fields are already normalised', () => {
    expect(translate('| tstats count from datamodel=Authentication by Authentication.user', { mapping: m }).dql).not.toContain('parse');
  });
});

describe('XML reader', () => {
  it('reads elements, attributes, text, CDATA and entities', () => {
    const root = parseXml('<?xml version="1.0"?>\n<!-- c -->\n<a x="1 &amp; 2" y=\'q\'>t &lt; <b/>u<![CDATA[<raw & text>]]><c>&#65;&#x42;&unknown;</c></a>\n');
    expect(root.name).toBe('a');
    expect([...root.attrs]).toEqual([
      ['x', '1 & 2'],
      ['y', 'q'],
    ]);
    expect(root.text).toBe('t < u<raw & text>');
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(root.children[1]?.text).toBe('AB&unknown;');
    expect(root.content.map((c) => (typeof c === 'string' ? c.trim() : `<${c.name}>`))).toEqual(['t <', '<b>', 'u', '<raw & text>', '<c>']);
  });

  it('never expands entities declared in a DOCTYPE', () => {
    const bomb = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;"><!ENTITY x SYSTEM "file:///etc/passwd">]><d>&b;&x;</d>';
    expect(parseXml(bomb).text).toBe('&b;&x;');
  });

  it('reports what is wrong and where', () => {
    const cases: [string, RegExp][] = [
      ['<a><b></a>', /<\/a> does not match <b> \(line 1\)/],
      ['<a>\n\n<b>', /<b> is not closed \(line 3\)/],
      ['<a x=1/>', /must be quoted/],
      ['<a x></a>', /has no value/],
      ['<a><![CDATA[x</a>', /CDATA section is not closed/],
      ['<a><!-- x</a>', /comment is not closed/],
      ['plain text', /not an XML document/],
      ['<a/>trailing', /after the root element/],
      [`${'<a>'.repeat(200)}`, /nested too deeply/],
    ];
    for (const [text, message] of cases) expect(() => parseXml(text), text).toThrow(message);
    expect(() => parseXml('<a x="1')).toThrow(XmlError);
  });
});

describe('reading Splunk dashboards', () => {
  it('reads a Simple XML dashboard: inputs, base searches, panels and their rows', () => {
    const model = readDashboard(view('web_overview.xml'));
    expect(model).toMatchObject({ format: 'simple-xml', title: 'Web overview', description: 'Traffic, errors and slow pages for the web tier.' });
    expect(model.inputs.map((i) => `${i.kind}:${i.token}`)).toEqual(['time:time', 'dropdown:host_tok', 'multiselect:status_tok', 'text:uri_tok']);
    expect(model.inputs[1]).toMatchObject({ valueField: 'host', defaultValue: '*', search: { spl: '`web_index` | stats count by host', earliest: '-24h' } });
    expect(model.inputs[2]).toMatchObject({ filterField: 'status', choices: [{ value: '500' }, { value: '502' }, { value: '503' }] });
    expect(model.panels.map((p) => `${p.kind}:${p.title}:${p.row?.index}.${p.row?.column}/${p.row?.span}`)).toEqual([
      'single:Requests:0.0/3',
      'single:Error rate %:0.1/3',
      'chart:Requests over time:0.2/3',
      'chart:Top pages:1.0/2',
      'table:Server errors:1.1/2',
      'chart:Session length:2.0/3',
      'table:Slow requests:2.1/3',
      'text:undefined:2.2/3',
    ]);
    // A post-process search continues its base search, and inherits its time range.
    expect(model.panels[0]?.search).toEqual({
      spl: '`web_index` sourcetype=access_combined host=$host_tok$ | fields _time host status uri bytes | stats count',
      earliest: '$time.earliest$',
      latest: '$time.latest$',
    });
    expect(model.panels[2]).toMatchObject({ chartType: 'line', dropped: ['Its drilldown (what a click does) is not carried over.'] });
    expect(model.panels[6]?.savedSearch).toBe('Web - slow requests');
    expect(model.panels[7]?.text).toBe(
      '### Runbook\n\nPage **web-oncall** when the error rate stays above 5% for ten minutes. See [the web runbook](https://wiki.example.com/web).',
    );
  });

  it('reads old Simple XML: visualizations directly in a row, searchString and searchName', () => {
    const model = readDashboard({
      name: 'old.xml',
      text: `<dashboard script="x.js" refresh="30"><row depends="$show$">
        <table><searchString>index=a</searchString><searchPostProcess>stats count</searchPostProcess><earliestTime>-1h</earliestTime></table>
        <chart><searchName>Saved one</searchName></chart>
        <viz type="sankey_app.sankey"><search><query>index=b</query></search></viz>
      </row><row><html>plain <i>text</i></html><panel ref="shared"/></row></dashboard>`,
    });
    expect(model.title).toBe('old');
    expect(model.panels[0]).toMatchObject({ search: { spl: 'index=a | stats count', earliest: '-1h' }, row: { span: 3 } });
    expect(model.panels[0]?.dropped[0]).toContain('depends/rejects');
    expect(model.panels[1]).toMatchObject({ savedSearch: 'Saved one', chartType: 'column' });
    expect(model.panels[2]).toMatchObject({ kind: 'custom' });
    expect(model.panels[3]?.text).toBe('plain *text*');
    expect(model.dropped).toEqual([
      'A prebuilt panel (ref="shared") is defined outside this file.',
      'Custom JavaScript (script=…) is not carried over.',
      'Automatic refresh is set in the Dynatrace dashboard itself.',
    ]);
  });

  it('reads a Dashboard Studio definition inside XML: chained searches, inputs, pixel layout', () => {
    const model = readDashboard(view('security_posture.xml'));
    expect(model).toMatchObject({ format: 'dashboard-studio', title: 'Security posture' });
    expect(model.inputs.map((i) => `${i.kind}:${i.token}`)).toEqual(['time:global_time', 'dropdown:user', 'text:top_n']);
    expect(model.inputs[1]).toMatchObject({ valueField: 'value', defaultValue: '*' });
    const total = model.panels.find((p) => p.title === 'Failed sign-ins');
    expect(total?.search?.spl).toBe(
      '| tstats count from datamodel=Authentication where Authentication.action=failure Authentication.user=$user$ by _time span=1h Authentication.user Authentication.src | stats sum(count) as failures',
    );
    expect(total?.search?.earliest).toBe('$global_time.earliest$');
    expect(total?.box).toEqual({ x: 20, y: 110, w: 340, h: 300, canvas: 1440 });
    expect(model.panels.find((p) => p.title === 'Firewall actions')?.search).toMatchObject({ earliest: '-60m@m', latest: 'now' });
    expect(model.panels.find((p) => p.title === 'Zone to zone')?.dropped[0]).toContain('splunk.sankey');
    expect(model.dropped).toEqual(['1 decorative element(s) (shapes, images, plain text boxes) were left out.']);
  });

  it('reads a bare Dashboard Studio JSON file with tabs', () => {
    const model = readDashboard({
      name: 'tabs.json',
      text: JSON.stringify({
        visualizations: {
          a: { type: 'splunk.table', dataSources: { primary: 's' } },
          b: { type: 'splunk.line', dataSources: { primary: 'saved' } },
          c: { type: 'splunk.pie' },
        },
        dataSources: { s: { type: 'ds.search', options: { query: 'index=a' } }, saved: { type: 'ds.savedSearch', options: { ref: 'R' } } },
        inputs: { i: { type: 'input.slider', options: { token: 't' } } },
        layout: {
          tabs: {
            items: [
              { layoutId: 'l1', label: 'One' },
              { layoutId: 'l2', label: 'Two' },
            ],
          },
          layoutDefinitions: {
            l1: { structure: [{ item: 'a', position: { x: 0, y: 0, w: 600, h: 200 } }] },
            l2: { structure: [{ item: 'b', position: { x: 0, y: 0, w: 600, h: 200 } }] },
          },
        },
      }),
    });
    expect(model.title).toBe('tabs');
    expect(model.panels.map((p) => p.text ?? p.kind)).toEqual(['## One', 'table', '## Two', 'chart', 'chart']);
    expect(model.panels[3]?.savedSearch).toBe('R');
    expect(model.panels[3]?.box?.y).toBeGreaterThan(model.panels[1]?.box?.y ?? 0);
    expect(model.dropped).toEqual(['An input of type "input.slider" was left out.']);
  });

  it('refuses what is not a dashboard, with a reason', () => {
    const cases: [string, RegExp][] = [
      ['hello', /neither XML nor JSON/],
      ['<nav><collection/></nav>', /starts with <dashboard> or <form>/],
      ['<dashboard><row>', /is not closed/],
      ['{"a": 1}', /not a Dashboard Studio definition/],
      ['{"a": ', /not valid JSON/],
      ['<dashboard version="2"><definition>{oops</definition></dashboard>', /not valid JSON/],
    ];
    for (const [text, message] of cases) {
      expect(() => readDashboard({ name: 'f', text }), text).toThrow(message);
      expect(() => readDashboard({ name: 'f', text }), text).toThrow(DashboardError);
    }
  });

  it('never throws anything but DashboardError for arbitrary input', () => {
    const seeds = [
      '<',
      '<a',
      '{',
      '[]',
      '{"visualizations":1}',
      '{"visualizations":{"a":1},"layout":{"structure":[{"item":"a"},{"item":"__proto__"},7]}}',
      '<form><row><panel><chart/></panel></row></form>',
      '<dashboard><fieldset><input/></fieldset></dashboard>',
      '﻿<dashboard/>',
    ];
    for (const text of seeds) {
      try {
        convertDashboardSource({ name: 'x', text });
      } catch (e) {
        expect(e, text).toBeInstanceOf(DashboardError);
      }
    }
  });
});

describe('converting a dashboard', () => {
  const security = mapping({
    indexes: { web: { buckets: ['web_logs'] } },
    macros: { web_index: { definition: 'index=web' } },
    fieldTypes: { status: 'number' },
    datamodels: { Authentication: { buckets: ['auth_logs'], fields: { user: 'user.name', src: 'client.ip', action: 'event.outcome' } } },
  });
  const tile = (c: DashboardConversion, title: string) => {
    const report = c.tiles.find((t) => t.title === title);
    if (!report) throw new Error(`no tile ${title}`);
    return { report, document: c.dashboard.content.tiles[report.id] as Record<string, unknown>, box: c.dashboard.content.layouts[report.id] };
  };

  it('writes a Dynatrace dashboard document: live tiles, text tiles, variables and a grid', () => {
    const c = convertDashboardSource(view('web_overview.xml'), { mapping: security });
    expect(c.dashboard).toMatchObject({ name: 'Web overview', type: 'dashboard', content: { version: 21 } });
    expect(c.counts).toEqual({ live: 5, manual: 2, text: 2 });
    expect(Object.keys(c.dashboard.content.tiles)).toEqual(Object.keys(c.dashboard.content.layouts));
    // Every data tile carries what Dynatrace requires of one.
    for (const t of Object.values(c.dashboard.content.tiles)) {
      if (t.type === 'data')
        expect(Object.keys(t)).toEqual(expect.arrayContaining(['title', 'query', 'visualization', 'visualizationSettings', 'querySettings']));
      else expect(t).toEqual({ type: 'markdown', content: expect.any(String) });
    }
  });

  it('turns tokens into variables: one value, several values, free text, and the time picker', () => {
    const c = convertDashboardSource(view('web_overview.xml'), { mapping: security });
    // A dropdown with an "All" choice is every value selected; the time token is the dashboard's own range.
    expect(tile(c, 'Requests').document.query).toBe(
      [
        'fetch logs, bucket:{"web_logs"}',
        '| filter in(host.name, array($host_tok))',
        '| fieldsKeep timestamp, host.name, status, uri, bytes, content',
        '| summarize count = count()',
      ].join('\n'),
    );
    // <valuePrefix>status="</valuePrefix> made the token a condition on status; the panel's own literal range stays.
    expect(tile(c, 'Server errors').document.query).toBe(
      [
        'fetch logs, bucket:{"web_logs"}, from:-4h@h',
        '| filter in(status, array($status_tok)) and in(host.name, array($host_tok))',
        '| filter isNotNull(host.name) and isNotNull(status)',
        '| summarize {count = count(), last_seen = max(timestamp)}, by:{host.name, status}',
        '| sort count desc',
      ].join('\n'),
    );
    expect(tile(c, 'Top pages').document.query).toContain('| filter contains(uri, $uri_tok, caseSensitive: false)');
    expect(c.dashboard.content.variables).toEqual([
      {
        key: 'host_tok',
        visible: true,
        editable: true,
        version: 2,
        type: 'query',
        input: 'fetch logs, bucket:{"web_logs"}, from:-24h\n| filter isNotNull(host.name)\n| summarize count = count(), by:{host.name}\n| fields host.name',
        multiple: true,
        defaultValue: '3420b2ac-f1cf-4b24-b62d-61ba1ba8ed05*',
      },
      {
        key: 'status_tok',
        visible: true,
        editable: true,
        version: 1,
        type: 'csv',
        input: '500,502,503',
        multiple: true,
        defaultValue: '3420b2ac-f1cf-4b24-b62d-61ba1ba8ed05*',
      },
      { key: 'uri_tok', visible: true, editable: true, version: 1, type: 'text', defaultValue: '*' },
    ]);
    expect(c.notes).toContain('The time input is the time frame picker of the Dynatrace dashboard.');
    // Every query, with its variables, passes the offline syntax check.
    for (const t of c.tiles) if (t.outcome === 'live') expect(checkDqlSyntax(t.result?.dql ?? '').ok, t.title).toBe(true);
    for (const v of c.dashboard.content.variables) if (typeof v.input === 'string' && v.type === 'query') expect(checkDqlSyntax(v.input).ok).toBe(true);
  });

  it('chooses the visualization from the Splunk panel and the shape of the result', () => {
    const c = convertDashboardSource(view('web_overview.xml'), { mapping: security });
    expect(Object.fromEntries(c.tiles.filter((t) => t.visualization).map((t) => [t.title, t.visualization]))).toEqual({
      Requests: 'singleValue',
      'Error rate %': 'singleValue',
      'Requests over time': 'lineChart',
      'Top pages': 'categoricalBarChart',
      'Server errors': 'table',
    });
    const s = convertDashboardSource(view('security_posture.xml'), { mapping: security });
    expect(Object.fromEntries(s.tiles.filter((t) => t.visualization).map((t) => [t.title, t.visualization]))).toEqual({
      'Failed sign-ins': 'singleValue',
      'Failures over time': 'areaChart',
      'Top sources': 'table',
      'Firewall actions': 'pieChart',
      'Zone to zone': 'table',
    });
  });

  it('keeps a panel it cannot translate as a text tile with the Splunk search, never as a live tile', () => {
    const c = convertDashboardSource(view('web_overview.xml'), { mapping: security });
    const session = tile(c, 'Session length');
    expect(session.report).toMatchObject({ outcome: 'manual', notes: ['transaction with options has no DQL equivalent.'] });
    expect(session.document.type).toBe('markdown');
    expect(session.document.content).toBe(
      [
        '### Session length',
        '**Not converted yet.** This Splunk panel needs manual work:',
        '- transaction with options has no DQL equivalent.',
        'Splunk search:',
        '    `web_index` | transaction JSESSIONID maxpause=5m | timechart avg(duration)',
        'DQL so far:',
        '    fetch logs, bucket:{"web_logs"}\n    // not translated: transaction JSESSIONID maxpause=5m\n    | makeTimeseries `avg(duration)` = avg(duration)',
      ].join('\n\n'),
    );
    // A saved search that was not given cannot be shown either.
    expect(tile(c, 'Slow requests').report).toMatchObject({ outcome: 'manual', notes: [expect.stringContaining('saved search "Web - slow requests"')] });
  });

  it('finds a saved search by name when it is given', () => {
    const savedSearches = new Map(
      parseSavedSearches(read('default/savedsearches.conf'), 'f').map((s) => [s.name, { spl: s.spl, earliest: s.earliest ?? '', latest: s.latest ?? '' }]),
    );
    const c = convertDashboardSource(view('web_overview.xml'), { mapping: security, savedSearches });
    expect(c.counts.manual).toBe(1);
    expect(tile(c, 'Slow requests').document.query).toContain(
      `fetch logs, bucket:{"web_logs"}, from:-60m@m\n| parse content, "DATA? 'duration=' LONG:'duration_ms'"`,
    );
  });

  it('lays rows out on 24 columns with one bottom edge per row', () => {
    const c = convertDashboardSource(view('web_overview.xml'), { mapping: security });
    const boxes = c.tiles.map((t) => c.dashboard.content.layouts[t.id]);
    expect(boxes).toEqual([
      { x: 0, y: 0, w: 24, h: 1 },
      { x: 0, y: 1, w: 8, h: 6 },
      { x: 8, y: 1, w: 8, h: 6 },
      { x: 16, y: 1, w: 8, h: 6 },
      { x: 0, y: 7, w: 12, h: 7 },
      { x: 12, y: 7, w: 12, h: 7 },
      { x: 0, y: 14, w: 8, h: 7 },
      { x: 8, y: 14, w: 8, h: 7 },
      { x: 16, y: 14, w: 8, h: 7 },
    ]);
  });

  it('scales a pixel layout to the grid without margins, gaps or overlaps', () => {
    const c = convertDashboardSource(view('security_posture.xml'), { mapping: security });
    const boxes = Object.values(c.dashboard.content.layouts);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(24);
    }
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    expect(Math.max(...boxes.map((b) => b.x + b.w))).toBe(24);
    expect(tile(c, 'Failed sign-ins').box).toEqual({ x: 0, y: 3, w: 6, h: 6 });
    expect(tile(c, 'Top sources').box?.y).toBe(9);
  });

  it('resolves chained searches, a data model and a row-count variable', () => {
    const c = convertDashboardSource(view('security_posture.xml'), { mapping: security });
    expect(tile(c, 'Top sources').document.query).toBe(
      [
        'fetch logs, bucket:{"auth_logs"}',
        '| filter matchesValue(event.outcome, "failure") and in(user.name, array($user))',
        '| filter isNotNull(user.name) and isNotNull(client.ip)',
        '| summarize count = count(), by:{timestamp = bin(timestamp, 1h), user.name, client.ip}',
        '| filter isNotNull(client.ip)',
        '| summarize failures = sum(count), by:{client.ip}',
        '| sort failures desc',
        '| limit $top_n:noquote',
      ].join('\n'),
    );
    expect(c.variables.map((v) => `${v.key}:${v.type}`)).toEqual(['user:query', 'top_n:text']);
    // The populating search already returns one field, named as the dashboard says.
    expect(c.dashboard.content.variables[0]?.input).toBe(
      [
        'fetch logs, bucket:{"auth_logs"}',
        '| filter isNotNull(user.name)',
        '| summarize count = count(), by:{user.name}',
        '| fieldsRename value = user.name',
        '| fieldsKeep value',
      ].join('\n'),
    );
  });

  it('gives a token Splunk sets elsewhere a text variable, and drops an input no tile uses', () => {
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [{ token: 'unused', kind: 'dropdown', choices: [{ label: 'A', value: 'a' }] }],
      panels: [
        { kind: 'table', title: 'By click', dropped: [], search: { spl: 'index=a host=$clicked$ user="$form.who$" | stats count by $split$' } },
        { kind: 'chart', title: 'Part', dropped: [], search: { spl: 'index=a msg="code $n$ seen" | stats count' } },
        { kind: 'single', dropped: [] },
        { kind: 'text', dropped: [] },
      ],
      dropped: [],
    });
    expect(c.tiles[0]?.result?.dql).toBe(
      'fetch logs\n| filter matchesValue(host.name, $clicked) and matchesValue(user, $who)\n| filter isNotNull($split:backtick)\n| summarize count = count(), by:{$split:backtick}',
    );
    expect(c.tiles[0]?.notes).toContain('The variable $split chooses a field; its values must be Grail field names, not Splunk ones.');
    // A token that is only part of a value stays text and is reported.
    expect(c.tiles[1]?.result?.dql).toContain('matchesValue(msg, "code $n$ seen")');
    expect(c.tiles[1]?.notes).toContain('$n$ is only part of a value here, so it could not become a dashboard variable; it was kept as plain text.');
    expect(c.tiles[2]).toMatchObject({ outcome: 'manual', notes: ['The panel has no search.'] });
    expect(c.tiles).toHaveLength(3);
    expect(c.variables.map((v) => `${v.key}:${v.type}`)).toEqual(['clicked:text', 'who:text', 'split:text']);
    expect(c.notes).toEqual(['The input "$unused$" is not used by any converted tile, so it has no variable.']);
  });

  it('compares a number field with the bare value of a variable', () => {
    const c = convertDashboard(
      {
        format: 'simple-xml',
        title: 'T',
        inputs: [
          { token: 'code', kind: 'dropdown', choices: [{ label: '500', value: '500' }], defaultValue: '500' },
          { token: 'q', kind: 'text', choices: [] },
        ],
        panels: [{ kind: 'table', dropped: [], search: { spl: 'index=a status=$code$ bytes>$q$ $q$ uri="$q$*" | eval big=if(bytes>=$q$, "$code$", "no")' } }],
        dropped: [],
      },
      { mapping: security },
    );
    expect(c.tiles[0]?.result?.dql).toBe(
      [
        'fetch logs',
        '| filter status == $code:noquote and bytes > $q:noquote and matchesPhrase(content, $q:triplequote) and startsWith(uri, $q, caseSensitive: false)',
        '| fieldsAdd big = if(bytes >= $q:noquote, $code, else: "no")',
      ].join('\n'),
    );
    expect(c.dashboard.content.variables[0]).toMatchObject({ key: 'code', type: 'csv', input: '500', multiple: false, defaultValue: '500' });
  });

  it('makes variable keys that Dynatrace accepts, without collisions', () => {
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [],
      panels: [{ kind: 'table', dropped: [], search: { spl: 'index=a a=$my.tok$ b=$my_tok$ c=$_under$ | head $n$' } }],
      dropped: [],
    });
    expect(c.variables.map((v) => v.key)).toEqual(['my_tok', 'my_tok_2', 'v__under', 'n']);
  });
});

describe('dashboard tokens outside a dashboard', () => {
  it('are kept as text and reported once per stage', () => {
    const r = translate('index=a host=$h$ user=$h$ | head $n$ | map search="search index=b user=$user$"');
    expect(r.diagnostics.filter((d) => d.code === 'SPL4009').map((d) => `${d.subject}@${d.stageIndex}`)).toEqual(['$h$@0', '$n$@1']);
    expect(r.variables).toBeUndefined();
  });
});
