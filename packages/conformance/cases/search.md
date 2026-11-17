# Search, data source and time range

Expected DQL is written from docs/spec/spl-dql-mapping.md §3. Diagnostics list warnings and errors as
`CODE@stage`; info notes are not listed.

## mapped index

```spl
index=web
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## index to another data object

```spl
index=security
```

```dql
fetch events
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## wildcard index mapping

```spl
index=fw_east
```

```dql
fetch logs, bucket:{"firewall_logs"}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "mapping-config.md, resolution rule 1" }
```

## several indexes joined by OR

```spl
index=web OR index=app
```

```dql
fetch logs, bucket:{"web_logs", "app_logs"}
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## unmapped index

```spl
index=unknown error
```

```dql
fetch logs
| filter matchesPhrase(content, "error")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4001@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## no index at all

```spl
error
```

```dql
fetch logs
| filter matchesPhrase(content, "error")
```

```json
{ "confidence": "review", "diagnostics": ["SPL4001@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## relative time range with snap

```spl
index=web earliest=-24h@h latest=-1h@h
```

```dql
fetch logs, bucket:{"web_logs"}, from:-24h@h, to:-1h@h
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## snap only, latest=now

```spl
index=web earliest=@d latest=now
```

```dql
fetch logs, bucket:{"web_logs"}, from:@d
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## week snap starts on Sunday in Splunk

```spl
index=web earliest=-1w@w
```

```dql
fetch logs, bucket:{"web_logs"}, from:-1w@w0
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2 time unit map" }
```

## month offset uses capital M

```spl
index=web earliest=-3mon@mon
```

```dql
fetch logs, bucket:{"web_logs"}, from:-3M@M
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2 time unit map" }
```

## offset after snap

```spl
index=web earliest=-1d@d+2h
```

```dql
fetch logs, bucket:{"web_logs"}, from:now()-1d@d+2h
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3015@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## calendar date converted with the mapping time zone

```spl
index=web earliest="10/27/2026:00:00:00"
```

```dql
fetch logs, bucket:{"web_logs"}, from:"2026-10-27T00:00:00Z"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3010@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## epoch seconds

```spl
index=web earliest=1700000000
```

```dql
fetch logs, bucket:{"web_logs"}, from:"2023-11-14T22:13:20Z"
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## all time

```spl
index=web earliest=0
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3015@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## real-time modifier

```spl
index=web earliest=rt-5m
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL2011@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## time picker range from options

```spl
index=web
```

```dql
fetch logs, bucket:{"web_logs"}, from:-7d
```

```json
{ "mapping": "web", "options": { "timeRange": { "earliest": "-7d" } }, "confidence": "high", "diagnostics": [], "verified": false, "source": "translation-engine.md TranslateOptions.timeRange" }
```

## phrase

```spl
index=web "connection timeout"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPhrase(content, "connection timeout")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## wildcard term

```spl
index=web fail*
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPhrase(content, "fail*")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3011@0"], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## CASE()

```spl
index=web CASE(Error)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPhrase(content, "Error", caseSensitive: true)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## TERM()

```spl
index=web TERM(10.0.0.1)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPhrase(content, "10.0.0.1")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3011@0"], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## host and source use built-in names

```spl
index=web host=web-01 source="/var/log/app.log"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(host.name, "web-01") and matchesValue(log.source, "/var/log/app.log")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2, §3.3" }
```

## field value is case-insensitive

```spl
index=web method=GET
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## leading and trailing wildcards

```spl
index=web uri="/api/*"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(url.path, "/api/*")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## wildcard in the middle

```spl
index=web uri="/api/*/users"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(url.path, "/api/*/users")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3011@0"], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## field exists

```spl
index=web user=*
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(user.name)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## != drops records without the field

```spl
index=web method!=GET
```

```dql
fetch logs, bucket:{"web_logs"}
| filter not matchesValue(http.method, "GET")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## NOT keeps records without the field

```spl
index=web NOT method=GET
```

```dql
fetch logs, bucket:{"web_logs"}
| filterOut matchesValue(http.method, "GET")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## NOT over a group

```spl
index=web NOT (method=GET OR method=HEAD)
```

```dql
fetch logs, bucket:{"web_logs"}
| filterOut matchesValue(http.method, "GET") or matchesValue(http.method, "HEAD")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3 emission rule" }
```

## nested NOT

```spl
index=web method=GET OR NOT status=200
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET") or isFalseOrNull(http.status == 200)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## IN list

```spl
index=web method IN (GET, "POST", PU*)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, {"GET", "POST", "PU*"})
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## typed number comparison

```spl
index=web status>=500 status<600
```

```dql
fetch logs, bucket:{"web_logs"}
| filter http.status >= 500 and http.status < 600
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## number literal on a typed number field

```spl
index=web status=404
```

```dql
fetch logs, bucket:{"web_logs"}
| filter http.status == 404
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## number literal on an untyped field

```spl
index=web code=200
```

```dql
fetch logs, bucket:{"web_logs"}
| filter code == 200
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@0"], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## number literal on a text field

```spl
index=web user=200
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(user.name, "200")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## OR binds tighter than AND in search

```spl
index=web method=GET status=200 OR status=201
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET") and (http.status == 200 or http.status == 201)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.1" }
```

## parentheses

```spl
index=web (method=GET OR method=POST) status=200
```

```dql
fetch logs, bucket:{"web_logs"}
| filter (matchesValue(http.method, "GET") or matchesValue(http.method, "POST")) and http.status == 200
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.1" }
```

## mapped sourcetype

```spl
index=web sourcetype=access_combined
```

```dql
fetch logs, bucket:{"web_logs"}
| filter log.source == "/var/log/nginx/access.log"
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## unmapped sourcetype is dropped

```spl
index=web sourcetype=syslog
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4002@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## mapped eventtype

```spl
index=security eventtype=failed_login
```

```dql
fetch events
| filter event.type == "auth" and outcome == "failure"
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## unmapped tag

```spl
index=web tag=pci
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4006@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## index mixed into an OR

```spl
index=web OR error
```

```dql
fetch logs
| filter dt.system.bucket == "web_logs" or matchesPhrase(content, "error")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3014@0", "SPL4001@0"], "verified": false, "source": "spl-dql-mapping.md §3.2" }
```

## later search stage

```spl
index=web | search method=POST
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "POST")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.1" }
```

## search after stats compares columns

```spl
index=web | stats count by host | search count>10
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| filter count > 10
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3, §4.3" }
```

## free text after a transforming command

```spl
index=web | stats count by host | search web
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| search "web"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3011@2"], "verified": false, "source": "spl-dql-mapping.md §3.3 mid-pipeline search" }
```

## search-time field without a mapping

```spl
index=web response_code=500
```

```dql
fetch logs, bucket:{"web_logs"}
| filter response_code == 500
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4003@0", "SPL3006@0"], "verified": false, "source": "spl-dql-mapping.md §4.5 (SPL4003)" }
```

## explicit search keyword

```spl
search index=web method=GET
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3" }
```

## comments are ignored

```spl
index=web ```only errors``` level=ERROR
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(loglevel, "ERROR")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "Splunk Search Manual: comments" }
```

## IN list written without spaces

```spl
index=web method IN ("GET","POST")
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, {"GET", "POST"})
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## numeric IN list on a field with no declared type

```spl
index=web code IN (1, 2)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter in(code, {1, 2})
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@0"], "verified": false, "source": "spl-dql-mapping.md §3.3" }
```

## dashboard token is kept as text and reported

```spl
index=web host=$host_tok$ | stats count by uri
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(host.name, "$host_tok$")
| filter isNotNull(url.path)
| summarize count = count(), by:{url.path}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4009@0"], "verified": false, "source": "spl-dql-mapping.md §2 SPL4009" }
```
