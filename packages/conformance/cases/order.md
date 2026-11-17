# Ordering, limiting, dedup

From docs/spec/spl-dql-mapping.md §4.4.

## sort descending after stats

```spl
index=web | stats count by host | sort -count
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| sort count desc
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## sort with a count

```spl
index=web | sort 10 -bytes
```

```dql
fetch logs, bucket:{"web_logs"}
| sort http.bytes desc
| limit 10
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## sort 0 has no limit

```spl
index=web | sort 0 uri
```

```dql
fetch logs, bucket:{"web_logs"}
| sort url.path asc
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## sort with num() and a trailing desc

```spl
index=web | sort num(code), uri desc
```

```dql
fetch logs, bucket:{"web_logs"}
| sort toDouble(code) desc, url.path desc
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## sort on an untyped field

```spl
index=web | sort code
```

```dql
fetch logs, bucket:{"web_logs"}
| sort code asc
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## head on raw events sorts newest first

```spl
index=web | head 20
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp desc
| limit 20
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## head default

```spl
index=web | stats count by host | head
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| limit 10
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## head with an expression

```spl
index=web | head bytes>100
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: head bytes>100
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2003@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## tail on raw events

```spl
index=web | tail 5
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp asc
| limit 5
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## tail after a transforming command

```spl
index=web | stats count by host | tail 5
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
// not translated: tail 5
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2010@2"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## reverse after sort flips the sort

```spl
index=web | sort -bytes | reverse
```

```dql
fetch logs, bucket:{"web_logs"}
| sort http.bytes desc
| sort http.bytes asc
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## reverse on raw events

```spl
index=web | reverse
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp asc
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## dedup keeps the newest event

```spl
index=web | dedup host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| dedup host.name, sort:{timestamp desc}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## dedup with sortby

```spl
index=web | dedup host, method sortby -bytes
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| dedup host.name, http.method, sort:{http.bytes desc}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## dedup keepempty

```spl
index=web | dedup host keepempty=true
```

```dql
fetch logs, bucket:{"web_logs"}
| dedup host.name, sort:{timestamp desc}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3002@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## dedup keeping several rows

```spl
index=web | dedup 3 host
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: dedup 3 host
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2003@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## dedup after stats

```spl
index=web | stats count by host, method | dedup host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| summarize count = count(), by:{host.name, http.method}
| filter isNotNull(host.name)
| dedup host.name
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@2"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## uniq after table

```spl
index=web | table host, method | uniq
```

```dql
fetch logs, bucket:{"web_logs"}
| fields host.name, http.method
| dedup host.name, http.method
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## tail after sort is the opposite sort

```spl
index=web | sort bytes | tail 5
```

```dql
fetch logs, bucket:{"web_logs"}
| sort http.bytes asc
| sort http.bytes desc
| limit 5
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## tail after reverse returns the newest events

```spl
index=web | reverse | tail 5
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp asc
| sort timestamp desc
| limit 5
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```

## tail after stats and sort

```spl
index=web | stats count by host | sort - count | tail 3
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| sort count desc
| sort count asc
| limit 3
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.4" }
```
