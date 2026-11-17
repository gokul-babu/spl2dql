# Malformed input

The translator never throws; every problem is a coded note (translation-engine.md invariants).

## empty

```spl

```

```dql

```

```json
{ "confidence": "none", "diagnostics": ["SPL1002@-1"], "verified": false, "source": "translation-engine.md" }
```

## trailing pipe

```spl
index=web |
```

```dql
fetch logs, bucket:{"web_logs"}
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1002@1"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## unterminated string

```spl
index=web "abc
```

```dql
// not translated: index=web "abc
```

```json
{ "mapping": "web", "confidence": "none", "diagnostics": ["SPL1001@0", "SPL1001@0"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## unbalanced parenthesis in a later stage

```spl
index=web | stats count by (
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: stats count by (
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1001@1", "SPL1003@1"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## eval with no expression

```spl
index=web | eval x=
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: eval x=
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1004@1"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## a function called without its argument

```spl
index=web | eval n=isnum()
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: eval n=isnum()
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1004@1"], "verified": false, "source": "spl-dql-mapping.md §2 SPL1004 (expression could not be read); re-test 2026-11-17 finding 11" }
```

## round with no argument in where

```spl
index=web | where round() > 1
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: where round() > 1
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1004@1"], "verified": false, "source": "spl-dql-mapping.md §2 SPL1004; re-test 2026-11-17 finding 11" }
```

## where with no condition

```spl
index=web | where
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: where
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1003@1"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## rename without AS

```spl
index=web | rename uri
```

```dql
fetch logs, bucket:{"web_logs"}
// not translated: rename uri
```

```json
{ "mapping": "web", "confidence": "low", "diagnostics": ["SPL1003@1"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## a transforming command cannot start a search

```spl
| stats count
```

```dql
summarize count = count()
```

```json
{ "confidence": "low", "diagnostics": ["SPL1007@0"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## dangling OR

```spl
index=web error OR
```

```dql
// not translated: index=web error OR
```

```json
{ "mapping": "web", "confidence": "none", "diagnostics": ["SPL1001@0"], "verified": false, "source": "spl-dql-mapping.md §2" }
```

## deeply nested parentheses

```spl
index=web ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((a))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))
```

```dql
// not translated: index=web ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((a))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))
```

```json
{ "mapping": "web", "confidence": "none", "diagnostics": ["SPL1001@0"], "verified": false, "source": "translation-engine.md limits (search nesting deeper than 200)" }
```
