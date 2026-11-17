# @spl2dql/core

The translation engine behind [`spl2dql`](https://www.npmjs.com/package/spl2dql): Splunk SPL in,
Dynatrace DQL out. No runtime dependencies, no I/O, no network — it runs in browsers, Web Workers
and Node.js. Deterministic: the same input always gives the same output.

```js
import { translate, parseMappingConfig } from '@spl2dql/core';

const mapping = parseMappingConfig({
  version: 1,
  indexes: { web: { buckets: ['web_logs'] } },
  fields: { status: 'http.status' },
});
if (!mapping.ok) throw new Error(mapping.issues.map((i) => i.message).join('\n'));

const result = translate('index=web status>=500 | stats count by host', {
  mapping: mapping.value,
  timeRange: { earliest: '-24h@h' },
});

result.dql;          // the DQL text
result.confidence;   // 'high' | 'review' | 'low' | 'none'
result.diagnostics;  // notes with stable codes (SPL3001…), spans in the SPL and the DQL
result.stages;       // per SPL stage: its status ('exact' | 'check' | 'untranslated') and the DQL it produced
```

`translate()` never throws on user input; problems are reported as diagnostics.

Dashboards and Splunk configuration files are handled here too, as pure functions on text:

```js
import { convertDashboardSource, importSplunkConfig, parseSavedSearches } from '@spl2dql/core';

// macros.conf, props.conf, transforms.conf, eventtypes.conf, tags.conf → mapping-file sections
const { sections, skipped } = importSplunkConfig([{ name: 'macros.conf', text: macrosConf }]);

// Simple XML or Dashboard Studio → a Dynatrace dashboard document
const { dashboard, tiles, variables, counts } = convertDashboardSource({ name: 'web.xml', text: xml }, { mapping: mapping.value });
JSON.stringify(dashboard);   // write this; tiles[] says which panels are live and which need manual work

// savedsearches.conf → searches with their saved time range, schedule and disabled flag
const searches = parseSavedSearches(savedsearchesConf, 'savedsearches.conf');
```

A dashboard panel becomes a live tile only when its search translated completely; otherwise the
tile keeps the Splunk search and says what is missing.

Also exported: `checkDqlSyntax` (offline DQL syntax check), `translateCondition`, `listCommands`,
`explainDiagnostic`, `highlightSpl`, `tokenizeDql`, `parseCsvSearches`, `parseConf`,
`collectMappingNeeds`, `mergeMappingSections`, `readDashboard`, `convertDashboard`, `regexToDpl`.

Apache-2.0. The DQL catalogue is generated from the Apache-2.0 reference in
[Dynatrace/dynatrace-for-ai](https://github.com/Dynatrace/dynatrace-for-ai); see NOTICE.

spl2dql is an independent open-source project. It is not affiliated with, endorsed by or supported
by Splunk Inc., Cisco or Dynatrace. Splunk, SPL, Dynatrace and DQL are trademarks of their
respective owners and are used only to describe what this tool works with. Provided without
warranty; check every translated query before relying on it.
