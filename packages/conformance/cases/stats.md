# Aggregation: stats, chart, timechart, top, rare, eventstats, transaction

From docs/spec/spl-dql-mapping.md §4.3 and §5.

## count

```spl
index=web | stats count
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count()
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3" }
```

## count by a field drops empty groups first

```spl
index=web | stats count by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3" }
```

## several aggregations and group fields

```spl
index=web | stats count, avg(bytes) as avg_bytes, max(bytes) by host, method
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| summarize {count = count(), avg_bytes = avg(http.bytes), `max(bytes)` = max(http.bytes)}, by:{host.name, http.method}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3, §5" }
```

## conditional count

```spl
index=web | stats count(eval(status>=500)) as errors, count as total by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {errors = countIf(http.status >= 500), total = count()}, by:{host.name}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## count of a field

```spl
index=web | stats count(user) as with_user
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize with_user = countIf(isNotNull(user.name))
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## distinct count

```spl
index=web | stats dc(user) as users, estdc(clientip) as ips
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize {users = countDistinctExact(user.name), ips = countDistinctApprox(client.ip)}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## percentiles and median

```spl
index=web | stats perc95(duration) as p95, median(duration)
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize {p95 = percentile(duration, 95), `median(duration)` = median(duration)}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3005@1", "SPL3005@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## values and list

```spl
index=web | stats values(method) as methods, list(uri) as uris by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {methods = arraySort(collectDistinct(http.method)), uris = collectArray(url.path)}, by:{host.name}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## range, sumsq, stdev, var

```spl
index=web | stats range(duration) as r, sumsq(duration) as s, stdev(duration) as sd, var(duration) as v
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize {r = max(duration) - min(duration), s = sum(duration * duration), sd = stddev(duration), v = variance(duration)}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## first on raw events sorts newest first

```spl
index=web | stats first(uri) as last_uri by host
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp desc
| filter isNotNull(host.name)
| summarize last_uri = takeFirst(url.path), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## earliest and latest sort oldest first

```spl
index=web | stats earliest(uri) as e, latest(uri) as l
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp asc
| summarize {e = takeFirst(url.path), l = takeLast(url.path)}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1", "SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## mixed first and earliest share one sort

```spl
index=web | stats first(uri) as f, earliest(uri) as e
```

```dql
fetch logs, bucket:{"web_logs"}
| sort timestamp asc
| summarize {f = takeLast(url.path), e = takeFirst(url.path)}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@1", "SPL3004@1"], "verified": false, "source": "spl-dql-mapping.md §5 (mixed rule)" }
```

## earliest_time

```spl
index=web | stats earliest_time(_time) as first_seen by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize first_seen = min(timestamp), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## unsupported aggregation among supported ones

```spl
index=web | stats count, mode(uri)
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count()
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL2005@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## only unsupported aggregations

```spl
index=web | stats mode(uri)
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: stats mode(uri)
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2005@1", "SPL2005@1"], "verified": false, "source": "spl-dql-mapping.md §5" }
```

## stats, sort and head

```spl
index=web | stats sum(bytes) as total by host | sort -total | head 5
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize total = sum(http.bytes), by:{host.name}
| sort total desc
| limit 5
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3, §4.4" }
```

## search-time extraction from the mapping file

```spl
index=web | stats avg(response_time) as rt by host
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'response_time=' DOUBLE:response_time", preserveFieldsOnFailure:true
| filter isNotNull(host.name)
| summarize rt = avg(response_time), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "mapping-config.md resolution rule 3" }
```

## chart by one field

```spl
index=web | chart count by method
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count(), by:{http.method}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3" }
```

## chart over and by

```spl
index=web | chart count over method by host
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count(), by:{http.method, host.name}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1", "SPL3009@1"], "verified": false, "source": "spl-dql-mapping.md §4.3" }
```

## chart with a numeric bin on the over field

```spl
index=web | chart count over duration span=100
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count(), by:{duration = bin(duration, 100)}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3" }
```

## timechart in series mode

```spl
index=web | timechart span=5m count by host
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries count = count(default: 0), by:{host.name}, interval:5m
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1", "SPL3009@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart (a)" }
```

## timechart without span or by

```spl
index=web | timechart count
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries count = count(default: 0)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart" }
```

## timechart with several aggregations

```spl
index=web | timechart span=1h avg(bytes) as avg_bytes, max(bytes)
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries {avg_bytes = avg(http.bytes), `max(bytes)` = max(http.bytes)}, interval:1h
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart" }
```

## timechart conditional count

```spl
index=web | timechart span=1h count(eval(status>=500)) as errors
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries errors = countIf(http.status >= 500, default: 0), interval:1h
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart zero fill" }
```

## timechart rate

```spl
index=web | timechart span=5m per_second(bytes) as bps
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries bps = sum(http.bytes, rate: 1s), interval:5m
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart" }
```

## timechart followed by a row filter uses tabular mode

```spl
index=web | timechart span=1h count | where count > 100
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count(), by:{timestamp = bin(timestamp, 1h)}
| filter count > 100
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart (b)" }
```

## calendar span

```spl
index=web | timechart span=1mon count
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize count = count(), by:{timestamp = timestamp@M}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart span" }
```

## timechart with an aggregation makeTimeseries does not support

```spl
index=web | timechart values(uri)
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize `values(uri)` = arraySort(collectDistinct(url.path)), by:{timestamp = bin(timestamp, 1h)}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1", "SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 timechart mode choice" }
```

## top with percent

```spl
index=web | top limit=5 uri
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(url.path)
| summarize count = count(), by:{url.path}
| summarize {_r = collectArray(record(url.path, count)), _total = sum(count)}
| expand _r
| fields url.path = _r[`url.path`], count = _r[count], percent = 100.0 * _r[count] / _total
| sort count desc
| limit 5
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3 top" }
```

## top without percent

```spl
index=web | top method showperc=f
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(http.method)
| summarize count = count(), by:{http.method}
| sort count desc
| limit 10
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3 top" }
```

## top by a group

```spl
index=web | top method by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(http.method)
| summarize count = count(), by:{host.name, http.method}
| sort host.name asc, count desc
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 top … by" }
```

## rare

```spl
index=web | rare uri showperc=false
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(url.path)
| summarize count = count(), by:{url.path}
| sort count asc
| limit 10
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3 rare" }
```

## eventstats on raw events joins the pipeline with itself

```spl
index=web | eventstats avg(bytes) as avg_bytes by host
```

```dql
fetch logs, bucket:{"web_logs"}
| join [fetch logs, bucket:{"web_logs"} | summarize avg_bytes = avg(http.bytes), by:{host.name}], on:{host.name}, kind:leftOuter, fields:{avg_bytes}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3012@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 eventstats strategy B" }
```

## eventstats without by uses a constant key

```spl
index=web | eventstats count as total
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd _k = 1
| join [fetch logs, bucket:{"web_logs"} | fieldsAdd _k = 1 | summarize total = count(), by:{_k}], on:{_k}, kind:leftOuter, fields:{total}
| fieldsRemove _k
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3012@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 eventstats strategy B" }
```

## eventstats after stats collects and expands

```spl
index=web | stats count by host, method | eventstats sum(count) as total by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name) and isNotNull(http.method)
| summarize count = count(), by:{host.name, http.method}
| summarize {_rows = collectArray(record(http.method, count)), total = sum(count)}, by:{host.name}
| expand _rows
| fields host.name, http.method = _rows[`http.method`], count = _rows[count], total
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.3 eventstats strategy A" }
```

## streamstats on raw events

```spl
index=web | streamstats count
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: streamstats count
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2010@1"], "verified": false, "source": "spl-dql-mapping.md §4.3" }
```

## accum after timechart

```spl
index=web | timechart span=1h sum(bytes) as b | accum b as total
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries b = sum(http.bytes), interval:1h
| fieldsAdd total = arrayCumulativeSum(b)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 array forms" }
```

## streamstats window after timechart

```spl
index=web | timechart span=1h count | streamstats window=3 avg(count) as smooth
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries count = count(default: 0), interval:1h
| fieldsAdd smooth = arrayMovingAvg(count, 3)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 array forms" }
```

## delta and trendline after timechart

```spl
index=web | timechart span=1h count | delta count as d | trendline sma5(count) as t
```

```dql
fetch logs, bucket:{"web_logs"}
| makeTimeseries count = count(default: 0), interval:1h
| fieldsAdd d = arrayDelta(count)
| fieldsAdd t = arrayMovingAvg(count, 5)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 array forms" }
```

## transaction without options

```spl
index=web | transaction session
```

```dql
fetch logs, bucket:{"web_logs"}
| summarize {_start = min(timestamp), _end = max(timestamp), eventcount = count(), content = collectArray(content)}, by:{session}
| fieldsAdd duration = (_end - _start) / 1s, timestamp = _start
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 transaction" }
```

## transaction with options

```spl
index=web | transaction session maxpause=5m
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: transaction session maxpause=5m
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1"], "verified": false, "source": "spl-dql-mapping.md §4.3 transaction" }
```

## earliest and latest of the event time need no sort

```spl
index=web | stats earliest(_time) as first_seen, latest(_time) as last_seen by host | eval seen=strftime(last_seen, "%F")
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {first_seen = min(timestamp), last_seen = max(timestamp)}, by:{host.name}
| fieldsAdd seen = formatTimestamp(last_seen, format: "yyyy-MM-dd")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3010@2"], "verified": false, "source": "spl-dql-mapping.md §5, §6.3" }
```

## eventstats keeps the time type

```spl
index=web | eventstats max(_time) as newest | eval lag=newest-_time
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd _k = 1
| join [fetch logs, bucket:{"web_logs"} | fieldsAdd _k = 1 | summarize newest = max(timestamp), by:{_k}], on:{_k}, kind:leftOuter, fields:{newest}
| fieldsRemove _k
| fieldsAdd lag = (newest - timestamp) / 1s
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3012@1"], "verified": false, "source": "spl-dql-mapping.md §4.3, §6.3" }
```
