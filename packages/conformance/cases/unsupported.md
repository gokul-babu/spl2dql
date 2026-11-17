# Commands with no translation

From docs/spec/spl-dql-mapping.md §4.8 and §8 ("never"). Each stage becomes a comment line and the
rest of the query is still translated.

## unknown command

```spl
index=web | mycommand x=1 | stats count
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: mycommand x=1
| summarize count = count()
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2001@1"], "verified": false, "source": "spl-dql-mapping.md §1" }
```

## iplocation

```spl
index=web | iplocation clientip
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: iplocation clientip
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## fields from an untranslated stage are unknown

```spl
index=web | iplocation clientip | stats count by Country
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: iplocation clientip
| filter isNotNull(Country)
| summarize count = count(), by:{Country}
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1", "SPL4003@2"], "verified": false, "source": "spl-dql-mapping.md §7.3 (unresolved fields)" }
```

## outputlookup is a side effect

```spl
index=web | stats count by host | outputlookup hosts.csv
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
// not translated: outputlookup hosts.csv
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2008@2"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## appendcols

```spl
index=web | stats count | appendcols [search index=app | stats count as app]
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count()
// not translated: appendcols [search index=app | stats count as app]
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2010@2"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## predict

```spl
index=web | timechart span=1h count | predict count
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count(), by:{timestamp = bin(timestamp, 1h)}
// not translated: predict count
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL3003@1", "SPL2002@2"], "verified": false, "source": "spl-dql-mapping.md §8" }
```

## datamodel

```spl
| datamodel Web search
```

```dql
// not translated: datamodel Web search
```

```json
{ "confidence": "none", "diagnostics": ["SPL4008@0"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## map

```spl
index=web | map search="search index=app user=$user$"
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: map search="search index=app user=$user$"
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## extract

```spl
index=web | extract pairdelim=",", kvdelim="="
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: extract pairdelim=",", kvdelim="="
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1"], "verified": false, "source": "spl-dql-mapping.md §4.5" }
```

## savedsearch

```spl
| savedsearch "Daily errors"
```

```dql
// not translated: savedsearch "Daily errors"
```

```json
{ "confidence": "none", "diagnostics": ["SPL4006@0"], "verified": false, "source": "spl-dql-mapping.md §8" }
```

## filldown

```spl
index=web | filldown user
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: filldown user
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2010@1"], "verified": false, "source": "spl-dql-mapping.md §8" }
```

## format inside a subsearch

```spl
index=web [search index=app | fields user | format]
```

```dql
// not translated: index=web [search index=app | fields user | format]
```

```json
{ "mapping": "web", "confidence": "none", "diagnostics": ["SPL2007@0", "SPL2007@0"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## a newline in an untranslated stage stays inside the comment

```spl
index=web | iplocation
  clientip
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: iplocation   clientip
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1"], "verified": false, "source": "translation-engine.md printer rules (comments are single lines)" }
```
