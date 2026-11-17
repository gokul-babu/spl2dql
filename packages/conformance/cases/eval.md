# eval and where

From docs/spec/spl-dql-mapping.md §4.1 and §6.

## arithmetic

```spl
index=web | eval kb=bytes/1024
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd kb = http.bytes / 1024.0
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1 division (docs.dynatrace.com DQL operators: long / long drops the fraction)" }
```

## assignment that uses an earlier one is split

```spl
index=web | eval kb=bytes/1024, mb=kb/1024, flag=1
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd kb = http.bytes / 1024.0
| fieldsAdd mb = kb / 1024.0, flag = 1
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.1, §6.1 division" }
```

## if

```spl
index=web | eval class=if(status>=500, "error", "ok")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd class = if(http.status >= 500, "error", else: "ok")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## case with a default

```spl
index=web | eval sev=case(status>=500, "high", status>=400, "medium", true(), "low")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd sev = if(http.status >= 500, "high", else: if(http.status >= 400, "medium", else: "low"))
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## case without a default

```spl
index=web | eval ok=case(status==200, "yes")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd ok = if(http.status == 200, "yes")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## substr is 1-based in Splunk

```spl
index=web | eval head=substr(uri, 1, 3), tail=substr(uri, 5), last=substr(uri, -3)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd head = substring(url.path, from: 0, to: 3), tail = substring(url.path, from: 4), last = substring(url.path, from: -3)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## substr with a computed position

```spl
index=web | eval part=substr(uri, duration, 2)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd part = substring(url.path, from: duration - 1, to: duration - 1 + 2)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3007@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## string functions

```spl
index=web | eval m=upper(method), n=len(uri), l=lower(user), t=trim(uri)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd m = upper(http.method), n = stringLength(url.path), l = lower(user.name), t = trim(url.path)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## dot concatenation

```spl
index=web | eval k=method . " " . uri
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd k = concat(http.method, " ", url.path)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1" }
```

## plus on two strings concatenates

```spl
index=web | eval k="a" + "b"
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd k = concat("a", "b")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1" }
```

## null handling functions

```spl
index=web | eval u=coalesce(user, "anon"), missing=isnull(user), present=isnotnull(user), z=nullif(user, "-")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd u = coalesce(user.name, "anon"), missing = isNull(user.name), present = isNotNull(user.name), z = if(user.name == "-", null, else: user.name)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## maths

```spl
index=web | eval r=round(duration/1000, 2), a=log(bytes), b=ln(bytes), c=pow(bytes, 2), d=log(bytes, 2), e=abs(duration)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd r = round(duration / 1000.0, decimals: 2), a = log10(http.bytes), b = log(http.bytes), c = power(http.bytes, 2), d = log(http.bytes) / log(2), e = abs(duration)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## conversions

```spl
index=web | eval s=tostring(status), n=tonumber(code), h=tostring(status, "hex"), x=tonumber(code, 16)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd s = toString(http.status), n = toDouble(code), h = concat("0x", numberToHexString(http.status)), x = hexStringToNumber(code)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## time difference in seconds

```spl
index=web | eval age=now()-_time
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd age = (now() - timestamp) / 1s
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.3" }
```

## time plus seconds

```spl
index=web | eval later=_time+3600
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd later = timestamp + 3600s
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.3" }
```

## strftime

```spl
index=web | eval day=strftime(_time, "%Y-%m-%d %H:%M")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd day = formatTimestamp(timestamp, format: "yyyy-MM-dd HH:mm")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3010@1"], "verified": false, "source": "spl-dql-mapping.md §6.3, §6.4" }
```

## strptime writes the format as a DPL literal

```spl
index=web | eval t=strptime(owner, "%d\\%m\\%Y")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd t = parse(owner, "TIMESTAMP('dd\\\\MM\\\\yyyy'):t")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3010@1"], "verified": false, "source": "spl-dql-mapping.md §6.3 strptime and §7 literal text: the Splunk format is %d\\%m\\%Y with single backslashes, the Java pattern dd\\MM\\yyyy; as a DPL literal each backslash is doubled, and the DQL string doubles them again (docs.dynatrace.com DPL Lines and Strings: a quote inside a quoted string is escaped by a backslash)" }
```

## strftime to epoch seconds

```spl
index=web | eval epoch=strftime(_time, "%s")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd epoch = unixSecondsFromTimestamp(timestamp)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.3" }
```

## relative_time

```spl
index=web | eval start=relative_time(now(), "-1d@d")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd start = (now() - 1d)@d
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.3 (inf: alignment of an expression)" }
```

## date_hour is computed from the timestamp

```spl
index=web | eval h=date_hour
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd h = getHour(timestamp)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3010@1"], "verified": false, "source": "spl-dql-mapping.md §6.3" }
```

## cidrmatch swaps arguments

```spl
index=web | where cidrmatch("10.0.0.0/8", clientip)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter ipIn(client.ip, "10.0.0.0/8")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## match() with a convertible regex

```spl
index=web | where match(uri, "^/api/v\d+")
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPattern(url.path, "'/api/v' [0-9]+ DATA?")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §6.2, §7.1" }
```

## like and IN

```spl
index=web | where like(uri, "/api/%") AND method IN ("GET", "POST")
```

```dql
fetch logs, bucket:{"web_logs"}
| filter like(url.path, "/api/%") and in(http.method, {"GET", "POST"})
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1" }
```

## where is case-sensitive

```spl
index=web | where method="get"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter http.method == "get"
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §3.4" }
```

## where NOT

```spl
index=web | where NOT status=200
```

```dql
fetch logs, bucket:{"web_logs"}
| filter not (http.status == 200)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1" }
```

## where compares an untyped field with a number

```spl
index=web | where code > 5
```

```dql
fetch logs, bucket:{"web_logs"}
| filter code > 5
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@1"], "verified": false, "source": "spl-dql-mapping.md §6.1" }
```

## multivalue functions

```spl
index=web | eval parts=split(uri, "/"), first=mvindex(parts, 1), some=mvindex(parts, 1, 2), rest=mvindex(parts, 1, -1), joined=mvjoin(parts, ","), n=mvcount(parts)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd parts = splitString(url.path, "/")
| fieldsAdd first = parts[1], some = arraySlice(parts, from: 1, to: 3), rest = arraySlice(parts, from: 1), joined = arrayToString(parts, delimiter: ","), n = arraySize(parts)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## hashes and decoding

```spl
index=web | eval h=md5(uri), s=sha256(uri), d=urldecode(uri)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd h = hashMd5(url.path), s = hashSha256(url.path), d = decodeUrl(url.path)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## json_extract and spath()

```spl
index=web | eval id=spath(_raw, "user.id"), skus=json_extract(_raw, "items{}.sku")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd id = jsonPath(content, "$.user.id"), skus = jsonPath(content, "$.items[*].sku")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## typeof and isnum

```spl
index=web | eval t=typeof(code), n=isnum(code)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd t = type(code), n = in(type(code), {"long", "double"})
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@1", "SPL3006@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## replace() with a literal and with a regex

```spl
index=web | eval a=replace(uri, "/v1/", "/v2/"), b=replace(uri, "\d+", "N")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd a = replaceString(url.path, "/v1/", "/v2/"), b = replacePattern(url.path, "[0-9]+", "N")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## eval min/max of several values

```spl
index=web | eval biggest=max(bytes, duration)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd biggest = arrayMax(array(http.bytes, duration))
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## unsupported function in one of several assignments

```spl
index=web | eval a=1, b=printf("%d", bytes)
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd a = 1
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL2004@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## only an unsupported function

```spl
index=web | eval b=printf("%d", bytes)
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: eval b=printf("%d", bytes)
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2004@1"], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## a field set by a failed assignment is unknown later

```spl
index=web | eval b=printf("%d", bytes) | where b="1"
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: eval b=printf("%d", bytes)
| filter b == "1"
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2004@1", "SPL4003@2"], "verified": false, "source": "spl-dql-mapping.md §7.3 (unresolved fields)" }
```

## eval field reference in single quotes

```spl
index=web | stats avg(bytes) by host | eval kb='avg(bytes)'/1024
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize `avg(bytes)` = avg(http.bytes), by:{host.name}
| fieldsAdd kb = `avg(bytes)` / 1024.0
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §1 aliases (inf: backticked alias)" }
```

## mvfilter on one field

```spl
index=web | eval parts=split(uri, "/") | eval nonempty=mvfilter(parts!="")
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd parts = splitString(url.path, "/")
| fieldsAdd nonempty = arrayRemoveNulls(iCollectArray(if(parts[] != "", parts[])))
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.2" }
```

## division of two fields keeps the fraction

```spl
index=web | stats count as total, count(eval(status>=500)) as errors by host | eval pct=round(errors/total*100, 2)
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize {total = count(), errors = countIf(http.status >= 500)}, by:{host.name}
| fieldsAdd pct = round(toDouble(errors) / total * 100, decimals: 2)
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1 division (docs.dynatrace.com DQL operators: long / long drops the fraction)" }
```

## division with a literal on the left, a decimal literal, and a chain

```spl
index=web | eval a=1/bytes, b=bytes/2.5, c=bytes/1024/1024
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd a = 1.0 / http.bytes, b = http.bytes / 2.5, c = http.bytes / 1024.0 / 1024
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1 division (docs.dynatrace.com DQL operators: long / long drops the fraction)" }
```

## a time multiplied or divided is a number of seconds

```spl
index=web | eval day=floor(_time/86400), ms=_time*1000
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd day = floor(unixSecondsFromTimestamp(timestamp) / 86400.0), ms = unixSecondsFromTimestamp(timestamp) * 1000
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.1, §6.3" }
```

## age from the newest event per host

```spl
index=web | stats max(_time) as last_seen by host | eval age=now()-last_seen | where age > 3600
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize last_seen = max(timestamp), by:{host.name}
| fieldsAdd age = (now() - last_seen) / 1s
| filter age > 3600
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §6.3 (aggregated time stays a time)" }
```

## match with alternatives of plain words

```spl
index=web | where match(uri, "login|logout")
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPattern(url.path, "DATA? ('login' | 'logout') DATA?")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §6.2, §7.1" }
```
