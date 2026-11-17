# Lookups, joins, appends and subsearches

From docs/spec/spl-dql-mapping.md §4.6 and §4.9.

## lookup with OUTPUT

```spl
index=web | lookup http_status code AS status OUTPUT description
```

```dql
fetch logs, bucket:{"web_logs"}
| lookup [load "/lookups/http_status"], sourceField:http.status, lookupField:code, fields:{description}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## lookup without OUTPUT uses the mapped columns

```spl
index=web | lookup http_status code AS status
```

```dql
fetch logs, bucket:{"web_logs"}
| lookup [load "/lookups/http_status"], sourceField:http.status, lookupField:code, fields:{description}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## lookup without OUTPUT or known columns

```spl
index=web | lookup assets host
```

```dql
fetch logs, bucket:{"web_logs"}
| lookup [load "/lookups/assets"], sourceField:host.name, lookupField:host
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3013@1", "SPL3016@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## lookup OUTPUTNEW keeps existing values

```spl
index=web | lookup assets host OUTPUTNEW owner
```

```dql
fetch logs, bucket:{"web_logs"}
| lookup [load "/lookups/assets"], sourceField:host.name, lookupField:host, fields:{_new_owner = owner}
| fieldsAdd owner = coalesce(owner, _new_owner)
| fieldsRemove _new_owner
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## unmapped lookup

```spl
index=web | lookup geo clientip OUTPUT city
```

```dql
fetch logs, bucket:{"web_logs"}
| lookup [load "/lookups/geo"], sourceField:client.ip, lookupField:clientip, fields:{city}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL4005@1", "SPL3013@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## inputlookup with where

```spl
| inputlookup http_status where code>=500
```

```dql
load "/lookups/http_status"
| filter code >= 500
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3006@0"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## inputlookup append

```spl
index=web | stats count by host | inputlookup append=t assets
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| append [load "/lookups/assets"]
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## join with a known subsearch schema

```spl
index=web | join type=left user [search index=app | stats count as app_events by user]
```

```dql
fetch logs, bucket:{"web_logs"}
| join [fetch logs, bucket:{"app_logs"} | filter isNotNull(user.name) | summarize app_events = count(), by:{user.name}], on:{user.name}, kind:leftOuter, fields:{app_events}
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3009@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## inner join with an unknown subsearch schema

```spl
index=web | join session [search index=app]
```

```dql
fetch logs, bucket:{"web_logs"}
| join [fetch logs, bucket:{"app_logs"}], on:{session}, kind:inner
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3009@1", "SPL3016@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## join with an untranslatable subsearch

```spl
index=web | join user [search index=app | transaction user maxspan=1m]
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: join user [search index=app | transaction user maxspan=1m]
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL2002@1", "SPL2007@1"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## append

```spl
index=web | stats count by host | append [search index=app | stats count by host]
```

```dql
fetch logs, bucket:{"web_logs"}
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| append [fetch logs, bucket:{"app_logs"} | filter isNotNull(host.name) | summarize count = count(), by:{host.name}]
```

```json
{ "mapping": "web", "confidence": "high", "diagnostics": [], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## union as the first command

```spl
| union [search index=web] [search index=app]
```

```dql
fetch logs, bucket:{"web_logs"}
| append [fetch logs, bucket:{"app_logs"}]
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@0"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## multisearch

```spl
| multisearch [search index=web method=GET] [search index=app]
```

```dql
fetch logs, bucket:{"web_logs"}
| filter matchesValue(http.method, "GET")
| append [fetch logs, bucket:{"app_logs"}]
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3004@0"], "verified": false, "source": "spl-dql-mapping.md §4.6" }
```

## subsearch as a filter

```spl
index=web [search index=app error | fields user]
```

```dql
fetch logs, bucket:{"web_logs"}
| filter user.name in [fetch logs, bucket:{"app_logs"} | filter matchesPhrase(content, "error") | fields user.name]
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3001@0", "SPL3009@0"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## NOT subsearch

```spl
index=web NOT [search index=app | table user]
```

```dql
fetch logs, bucket:{"web_logs"}
| filterOut user.name in [fetch logs, bucket:{"app_logs"} | fields user.name]
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3001@0", "SPL3009@0"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## subsearch with return

```spl
index=web [search index=app | sort -bytes | return user]
```

```dql
fetch logs, bucket:{"web_logs"}
| filter user.name in [fetch logs, bucket:{"app_logs"} | sort http.bytes desc | fields user.name | limit 1]
```

```json
{ "mapping": "web", "confidence": "review", "diagnostics": ["SPL3001@0", "SPL3009@0"], "verified": false, "source": "spl-dql-mapping.md §4.9" }
```

## subsearch returning several fields

```spl
index=web [search index=app | table user, host]
```

```dql
// not translated: index=web [search index=app | table user, host]
```

```json
{ "mapping": "web", "confidence": "none", "diagnostics": ["SPL2007@0"], "verified": false, "source": "spl-dql-mapping.md §4.9 (T3: the whole stage is not translated)" }
```
