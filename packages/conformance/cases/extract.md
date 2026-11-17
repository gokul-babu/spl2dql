# Extraction: rex, regex, spath

From docs/spec/spl-dql-mapping.md §4.5 and §7.

## rex with a word capture

```spl
index=web | rex field=_raw "user=(?<username>\w+)"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'user=' [a-zA-Z0-9_]+:username"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex with a number capture and trailing text

```spl
index=web | rex "took (?<ms>\d+)ms"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'took ' LONG:ms 'ms'"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex anchored at the start

```spl
index=web | rex field=uri "^/api/v(?<version>\d+)/"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse url.path, "'/api/v' LONG:version '/'"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex with a character class capture

```spl
index=web | rex "status=(?<st>[^,]+),"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'status=' [^,]+:st ','"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex capture to the end

```spl
index=web | rex "msg=(?<msg>.*)"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'msg=' DATA:msg"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1 (inf: DATA at the end)" }
```

## rex lazy capture followed by text

```spl
index=web | rex "a=(?<a>.+?) b=(?<b>\S+)"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'a=' LD:a ' b=' NSPACE:b"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex with an alternatives group and a decimal

```spl
index=web | rex "(?:GET|POST) took (?<secs>\d+\.\d+)"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? ('GET' | 'POST') ' took ' DOUBLE:secs"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex then use the field

```spl
index=web | rex "user=(?<username>\w+)" | stats count by username
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'user=' [a-zA-Z0-9_]+:username"
| filter isNotNull(username)
| summarize count = count(), by:{username}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex ignoring case

```spl
index=web | rex "(?i)error (?<code>\d+)" | stats count by code
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? [eE] [rR] [rR] [oO] [rR] ' ' LONG:code"
| filter isNotNull(code)
| summarize count = count(), by:{code}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1 (?i)" }
```

## rex with an unsupported inline flag

```spl
index=web | rex "(?m)^error (?<code>\d+)" | stats count by code
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: rex "(?m)^error (?<code>\d+)"
| filter isNotNull(code)
| summarize count = count(), by:{code}
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2006@1"], "verified": false, "source": "spl-dql-mapping.md §7.2, §7.3" }
```

## rex capturing an IP address as text

```spl
index=web | rex "ip=(?<ip>\d+\.\d+\.\d+\.\d+)" | stats count by ip
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'ip=' ([0-9]+ '.' [0-9]+ '.' [0-9]+ '.' [0-9]+):ip"
| filter isNotNull(ip)
| summarize count = count(), by:{ip}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1 sequence group export" }
```

## rex with an unconvertible capture

```spl
index=web | rex "id=(?<id>a.*b)c" | stats count by id
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: rex "id=(?<id>a.*b)c"
| filter isNotNull(id)
| summarize count = count(), by:{id}
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2006@1", "SPL4003@2"], "verified": false, "source": "spl-dql-mapping.md §7.2, §7.3" }
```

## rex with alternatives, a compound capture and an optional part

```spl
index=web | rex "(?<verb>GET|POST) /api/(?<version>v\d+)/(?<res>[\w-]+)(?:\?(?<query>\S+))?"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? ('GET' | 'POST'):verb ' /api/' ('v' [0-9]+):version '/' [a-zA-Z0-9_-]+:res ('?' NSPACE:query)?"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1" }
```

## rex with look-around and a word boundary

```spl
index=web | rex "\bsession (?<sid>[0-9a-f]+)(?= closed)"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? !<<[a-zA-Z0-9_] 'session ' [0-9a-f]+:sid >>' closed'"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1 look-around, word boundary" }
```

## rex with a group repeated a fixed number of times

```spl
index=web | rex "mac=(?<mac>[0-9a-f]{2}(?::[0-9a-f]{2}){5})"
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "DATA? 'mac=' ([0-9a-f]{2} ':' [0-9a-f]{2} ':' [0-9a-f]{2} ':' [0-9a-f]{2} ':' [0-9a-f]{2} ':' [0-9a-f]{2}):mac"
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §7.1 fixed count" }
```

## rex mode=sed with a literal

```spl
index=web | rex mode=sed field=uri "s/\/v1\//\/v2\//g"
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd url.path = replaceString(url.path, "/v1/", "/v2/")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.5" }
```

## rex mode=sed with a regex

```spl
index=web | rex mode=sed "s/\d+/N/g"
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd content = replacePattern(content, "[0-9]+", "N")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §4.5" }
```

## rex with max_match returns every match

```spl
index=web | rex max_match=0 "id=(?<id>\d+)"
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd id = parseAll(content, "'id=' LONG:id")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1", "SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §7.2a" }
```

## rex with max_match and a limit

```spl
index=web | rex field=uri max_match=3 "(?<part>[^/]+)"
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd part = arraySlice(parseAll(url.path, "[^/]+:part"), from: 0, to: 3)
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1", "SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §7.2a" }
```

## rex with max_match and two groups

```spl
index=web | rex max_match=0 "(?<k>\w+)=(?<v>\d+)"
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: rex max_match=0 "(?<k>\w+)=(?<v>\d+)"
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2003@1"], "verified": false, "source": "spl-dql-mapping.md §7.2a" }
```

## regex keeps matching events

```spl
index=web | regex uri="^/api/"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesPattern(url.path, "'/api/' DATA?")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §4.1" }
```

## regex not equal on the raw event

```spl
index=web | regex _raw!="debug"
```

```dql
fetch logs, bucket:{"web_logs"}
| filter not matchesPattern(content, "DATA? 'debug' DATA?")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3008@1"], "verified": false, "source": "spl-dql-mapping.md §4.1" }
```

## regex with a back-reference

```spl
index=web | regex "(a)\1"
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: regex "(a)\1"
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2006@1"], "verified": false, "source": "spl-dql-mapping.md §7.2" }
```

## spath without arguments

```spl
index=web | spath
```

```dql
fetch logs, bucket:{"web_logs"}
| parse content, "JSON:json"
| fieldsFlatten json
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3016@1"], "verified": false, "source": "spl-dql-mapping.md §4.5" }
```

## spath one path

```spl
index=web | spath path=user.id output=uid
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd uid = jsonPath(content, "$.user.id")
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.5" }
```

## spath array path

```spl
index=web | spath path=items{}.sku
```

```dql
fetch logs, bucket:{"web_logs"}
| fieldsAdd `items{}.sku` = jsonPath(content, "$.items[*].sku")
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §4.5" }
```
