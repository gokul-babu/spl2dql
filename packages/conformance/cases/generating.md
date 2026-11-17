# Generating commands, metrics and binning

From docs/spec/spl-dql-mapping.md §4.8 and §8.

## makeresults

```spl
| makeresults
```

```dql
data record(timestamp = now())
```

```json
{ "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## makeresults with a count

```spl
| makeresults count=5
```

```dql
// not translated: makeresults count=5
```

```json
{ "confidence": "none", "diagnostics": ["SPL2003@0"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## makeresults then eval

```spl
| makeresults | eval x=1
```

```dql
data record(timestamp = now())
| fieldsAdd x = 1
```

```json
{ "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## tstats by a field

```spl
| tstats count where index=web by host
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@0"], "verified": false, "source": "spl-dql-mapping.md §4.8 (Splunk tstats: rows with an empty BY field are left out unless fillnull_value is set)" }
```

## tstats by time

```spl
| tstats count where index=web method=GET by _time span=1h
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET")
| summarize count = count(), by:{timestamp = bin(timestamp, 1h)}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@0"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## tstats with fillnull_value keeps empty groups

```spl
| tstats fillnull_value=NULL count where index=web by host, method
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd host.name = coalesce(host.name, "NULL"), http.method = coalesce(http.method, "NULL")
| summarize count = count(), by:{host.name, http.method}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@0"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## tstats from a data model without a mapping entry

```spl
| tstats count from datamodel=Web by Web.status
```

```dql
fetch logs
| filter isNotNull(http.status)
| summarize count = count(), by:{http.status}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@0", "SPL4008@0"], "verified": false, "source": "spl-dql-mapping.md §4.8, mapping-config.md datamodels" }
```

## tstats from a mapped data model

```spl
| tstats summariesonly=true count from datamodel=Authentication where Authentication.action=failure by Authentication.user, Authentication.src | rename Authentication.* as * | where count > 10
```

```dql
fetch logs, bucket:{"auth_logs"}
| filter (event.category == "authentication") and matchesValue(event.outcome, "failure")
| filter isNotNull(user.name) and isNotNull(client.ip)
| summarize count = count(), by:{user.name, client.ip}
| filter count > 10
```

```json
{ "mapping": "security", "confidence": "review", "diagnostics": ["SPL3014@0"], "verified": false, "source": "spl-dql-mapping.md §4.8, mapping-config.md datamodels" }
```

## tstats on a dataset with first and last time

```spl
| tstats count min(_time) as firstTime max(_time) as lastTime from datamodel=Endpoint.Processes where Processes.process_name=powershell.exe by Processes.dest Processes.process_name | `drop_dm_object_name(Processes)` | eval hours=round((lastTime-firstTime)/3600, 1)
```

```dql
fetch logs
| filter (event.type == "process") and matchesValue(process.executable.name, "powershell.exe")
| filter isNotNull(host.name) and isNotNull(process.executable.name)
| summarize {count = count(), firstTime = min(timestamp), lastTime = max(timestamp)}, by:{host.name, process.executable.name}
| fieldsAdd hours = round((lastTime - firstTime) / 1s / 3600, decimals: 1)
```

```json
{ "mapping": "security", "confidence": "review", "diagnostics": ["SPL3014@0"], "verified": false, "source": "spl-dql-mapping.md §4.8, §6.3, mapping-config.md datamodels" }
```

## tstats prestats feeds the next reporting command

```spl
| tstats prestats=t count from datamodel=Authentication by _time span=1h, Authentication.action | timechart span=1h count by Authentication.action
```

```dql
fetch logs, bucket:{"auth_logs"}
| filter event.category == "authentication"
| makeTimeseries count = count(default: 0), by:{event.outcome}, interval:1h
```

```json
{ "mapping": "security", "confidence": "review", "diagnostics": ["SPL3014@0", "SPL3003@1", "SPL3009@1"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## a child dataset falls back to the model entry

```spl
| datamodel Authentication Failed_Authentication search | stats count by Authentication.src
```

```dql
fetch logs, bucket:{"auth_logs"}
| filter event.category == "authentication"
| filter isNotNull(client.ip)
| summarize count = count(), by:{client.ip}
```

```json
{ "mapping": "security", "confidence": "review", "diagnostics": ["SPL4008@0"], "verified": false, "source": "spl-dql-mapping.md §4.8, mapping-config.md datamodels" }
```

## from datamodel

```spl
| from datamodel:"Authentication.Authentication" | stats count by user
```

```dql
fetch logs, bucket:{"auth_logs"}
| filter event.category == "authentication"
| filter isNotNull(user.name)
| summarize count = count(), by:{user.name}
```

```json
{ "mapping": "security", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.8, mapping-config.md datamodels" }
```

## mstats

```spl
| mstats avg(cpu.pct) as cpu WHERE index=metrics host=web-01 span=1m BY host
```

```dql
timeseries cpu = avg(dt.host.cpu.usage), by:{host.name}, filter:matchesValue(host.name, "web-01"), interval:1m
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3003@0"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## mstats with an unmapped metric

```spl
| mstats max(mem.used) span=5m
```

```dql
timeseries `max(mem.used)` = max(mem.used), interval:5m
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4007@0", "SPL3003@0"], "verified": false, "source": "spl-dql-mapping.md §4.8" }
```

## bin the time

```spl
index=web | bin _time span=5m | stats count by _time
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd timestamp = bin(timestamp, 5m)
| filter isNotNull(timestamp)
| summarize count = count(), by:{timestamp}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §8 (bin)" }
```

## bin a number into a new field

```spl
index=web | bin duration span=100 as dbucket
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd dbucket = bin(duration, 100)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §8 (bin)" }
```

## bin by month

```spl
index=web | bucket _time span=1mon
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd timestamp = timestamp@M
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §8 (bin)" }
```

## bin with bins=

```spl
index=web | bin _time bins=10
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: bin _time bins=10
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2003@1"], "verified": false, "source": "spl-dql-mapping.md §8 (bin)" }
```
