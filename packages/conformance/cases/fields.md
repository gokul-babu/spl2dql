# Field shaping and multivalue

From docs/spec/spl-dql-mapping.md §4.2 and §4.7.

## table

```spl
index=web | table host, uri, status
```

```dql
fetch logs, bucket:{"web_logs"}
| fields host.name, url.path, http.status
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## table with a wildcard on raw events

```spl
index=web | table host, ur*
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsKeep host.name, "ur*"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL2009@1"], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## table wildcard against known columns uses Splunk names

```spl
index=web | stats count by host, method | table m*, count
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| summarize count = count(), by:{host.name, http.method}
| fields http.method, count
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2 (wildcards resolved against a known schema)" }
```

## fields keeps _time and _raw on events

```spl
index=web | fields host, uri
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsKeep host.name, url.path, timestamp, content
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## fields after stats

```spl
index=web | stats count by host, method | fields host, count
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| summarize count = count(), by:{host.name, http.method}
| fieldsKeep host.name, count
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## fields minus

```spl
index=web | fields - user, clientip
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsRemove user.name, client.ip
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## rename

```spl
index=web | rename uri AS path, method AS "http verb"
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsRename path = url.path, `http verb` = http.method
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2 (fieldsRename new = old)" }
```

## rename with a wildcard

```spl
index=web | rename http_* AS h_*
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: rename http_* AS h_*
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2009@1"], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## rename to a name with a backtick is not translated

```spl
index=web | rename uri AS "a`b"
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: rename uri AS "a`b"
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2012@1"], "verified": false, "source": "ADR-029 (no confirmed escape for a backtick in a backticked name); spl-dql-mapping.md §2 SPL2012; translation-engine.md printer rules (untranslated stage)" }
```

## eval creating a field whose name hides pipeline commands is not translated

```spl
index=web | eval "x` = 1 | limit 0 | fieldsAdd `y" = 1
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: eval "x` = 1 | limit 0 | fieldsAdd `y" = 1
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2012@1"], "verified": false, "source": "ADR-029; security review 2026-11-16 finding 8; spl-dql-mapping.md §2 SPL2012" }
```

## fillnull with a value and fields

```spl
index=web | fillnull value="unknown" user
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd user.name = coalesce(user.name, "unknown")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## fillnull without fields after stats

```spl
index=web | stats sum(bytes) as b by host | fillnull
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize b = sum(http.bytes), by:{host.name}
| fieldsAdd host.name = coalesce(host.name, 0), b = coalesce(b, 0)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2 (known schema)" }
```

## fillnull without fields on raw events

```spl
index=web | fillnull
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: fillnull
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2009@1"], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## replace

```spl
index=web | replace "GET" WITH "read", "POST" WITH "write" IN method
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd http.method = if(http.method == "GET", "read", else: if(http.method == "POST", "write", else: http.method))
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## convert ctime on the timestamp

```spl
index=web | convert ctime(_time) AS t
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd t = formatTimestamp(timestamp, format: "MM/dd/yyyy HH:mm:ss")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3010@1"], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## convert num

```spl
index=web | convert num(code)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd code = toDouble(code)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## addtotals with listed fields

```spl
index=web | stats sum(bytes) as b, sum(duration) as d by host | addtotals fieldname=all b d
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {b = sum(http.bytes), d = sum(duration)}, by:{host.name}
| fieldsAdd all = coalesce(b, 0) + coalesce(d, 0)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## addtotals without fields

```spl
index=web | addtotals
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: addtotals
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2009@1"], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## foreach over listed fields

```spl
index=web | stats sum(bytes) as b, sum(duration) as d by host | foreach b d [eval <<FIELD>>_k = <<FIELD>> / 1000]
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {b = sum(http.bytes), d = sum(duration)}, by:{host.name}
| fieldsAdd b_k = b / 1000.0, d_k = d / 1000.0
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.2" }
```

## makemv

```spl
index=web | makemv delim="," user
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd user.name = splitString(user.name, ",")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.7" }
```

## mvexpand with a limit

```spl
index=web | mvexpand user limit=5
```

```dql
fetch logs, bucket:{"web_logs"}
| expand user.name, limit:5
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.7" }
```

## nomv

```spl
index=web | nomv user
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd user.name = arrayToString(user.name, delimiter: "\n")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.7" }
```

## mvcombine after stats

```spl
index=web | stats count by host, method | mvcombine method
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| summarize count = count(), by:{host.name, http.method}
| summarize http.method = collectArray(http.method), by:{host.name, count}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@2"], "verified": false, "source": "spl-dql-mapping.md §4.7" }
```

## rangemap

```spl
index=web | rangemap field=duration low=0-100 high=101-1000 default=slow
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd range = if(duration >= 0 and duration <= 100, "low", else: if(duration >= 101 and duration <= 1000, "high", else: "slow"))
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "Splunk Search Reference: rangemap" }
```

## display-only commands are dropped

```spl
index=web | stats count by host | fieldformat count=tostring(count, "commas") | highlight web
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.1" }
```

## rename a default aggregate name without quotes

```spl
index=web | stats avg(bytes) by host | rename avg(bytes) as average
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize `avg(bytes)` = avg(http.bytes), by:{host.name}
| fieldsRename average = `avg(bytes)`
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §1 default aggregate names" }
```

## sort and table by a default aggregate name

```spl
index=web | stats count, sum(bytes) by host | sort - sum(bytes) | table host sum(bytes)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {count = count(), `sum(bytes)` = sum(http.bytes)}, by:{host.name}
| sort `sum(bytes)` desc
| fields host.name, `sum(bytes)`
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §1 default aggregate names, §4.2, §4.4" }
```
