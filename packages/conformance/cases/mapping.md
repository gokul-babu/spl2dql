# Mapping file: macros, strict mode, defaults

From docs/spec/mapping-config.md and spl-dql-mapping.md §4.9.

## macro in the search

```spl
`errors_only` index=web
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(loglevel, "ERROR")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## macro with an argument

```spl
index=web `recent(4h)`
```

```dql
fetch logs, bucket:{"web_logs"}, from:-4h
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## macro that is a whole stage

```spl
index=web | `count_by(host)`
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## unknown macro inside the search is dropped

```spl
index=web `nope` method=GET
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4004@0"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## unknown macro as a stage

```spl
index=web | `my_stats`
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: `my_stats`
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL4004@1"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## recursive macro

```spl
index=web `loop`
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1005@0"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## strict mode makes a missing mapping an error

```spl
index=nope
```

```dql
fetch logs
```

```json
{ "mapping": "web", "options": { "strict": true }, "confidence": "low", "diagnostics": ["SPL4001@0"], "verified": false, "source": "mapping-config.md strict" }
```

## without a mapping file built-in names still apply

```spl
index=main host=web-01 | stats count by source
```

```dql
fetch logs
| filter matchesValue(host.name, "web-01")
| filter isNotNull(log.source)
| summarize count = count(), by:{log.source}
```

```json
{ "confidence": "review", "diagnostics": ["SPL4001@0"], "verified": false, "source": "mapping-config.md built-in defaults" }
```

## sourcetype as a field has no Grail equivalent

```spl
index=web | stats count by sourcetype
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(sourcetype)
| summarize count = count(), by:{sourcetype}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4002@1"], "verified": false, "source": "mapping-config.md built-in defaults" }
```
