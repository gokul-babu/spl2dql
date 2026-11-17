# SPL → DQL Mapping Specification

Status: draft v0.1 · Audience: implementers of the translator core · Scope: translation rules only (parser architecture, mapping-file schema and confidence scoring are specified elsewhere).

## 1. How to read this document

This file is the single source of truth for *what* each SPL construct becomes in DQL. Each SPL command is one registry module: it parses its own arguments, lowers to the typed pipeline IR, and the DQL emitter prints the templates given here. Anything not listed is an `Unsupported` stage (`SPL2001`).

**Tiers**

| Tier | Meaning | Diagnostics |
|---|---|---|
| T1 | Deterministic and faithful. | none, or `SPL5xxx` info only |
| T2 | Translated, with a documented behavioural caveat. | at least one `SPL3xxx` or `SPL4xxx` |
| T3 | Not translated. The stage is emitted as a `// not translated: …` comment and the pipeline continues. | `SPL2xxx` |

A command's tier is its *best case*. Individual arguments can lower it; the "Arguments" column says which.

**Provenance** — every row carries one tag:

| Tag | Meaning |
|---|---|
| `ref` | Confirmed in the local DQL reference (`dt-dql-essentials`, Apache-2.0) or docs.dynatrace.com. |
| `nb` | Stated in the S2D migration notebooks (community, unlicensed; facts only, reworded here). Several were measured on a tenant by the author. |
| `inf` | Inference. Plausible but unverified. **Must be checked on a tenant (§9) before it is trusted or promoted to T1.** |
| `spl` | Splunk-side behaviour confirmed in Splunk docs. |

**Global emission rules**

| Rule | Detail | Prov |
|---|---|---|
| Strings | DQL strings use double quotes only. Escape `\` and `"`. Use `"""…"""` when a DPL pattern itself needs double quotes. | ref |
| Quotes in SPL | In `search`, quotes delimit values. In `eval`/`where`, **double quotes are string literals and single quotes are field names**. | spl |
| Field names | Wrap in backticks when the name has characters outside `[A-Za-z0-9_.]` (spaces, `-`, `(`, `{`…). Inside `join`/`lookup` conditions a dotted name needs ``left[`a.b`]``. Do **not** backtick names inside `lookup … fields:{}`. | ref |
| Built-in field map | `_time`→`timestamp`, `_raw`→`content`, `host`→`host.name`, `source`→`log.source`, `index`→`dt.system.bucket`. The mapping file overrides these. `sourcetype` has no default. Emits `SPL5002` once per query. | nb, ref |
| Keywords | Emit lowercase `and`, `or`, `not`, `xor`. Always parenthesise mixed `and`/`or`. | ref |
| Aliases | Every aggregation gets an explicit alias equal to the SPL output name (`count = count()`; `` `avg(bytes)` = avg(bytes) `` when SPL had no `AS`). Unaliased DQL results are named like `count()` and need backticks later. | nb, ref; backticked alias with parentheses is `inf` |
| Default aggregate names in field lists | In a field list (`rename`, `sort`, `fields`, `table`, `by` …) Splunk accepts a default aggregate name without quotes: `rename avg(bytes) as average`, `sort - sum(bytes)`. A word directly followed by a parenthesised group is read as one field name and emitted in backticks. In `eval`/`where` it still needs single quotes, as in Splunk. | spl |
| Lists | Static lists are `{a, b}` or `array(a, b)`. Square brackets are sub-queries only. `by:` and `on:` always take `{}`. | ref |
| Comments | `//` line comments. | ref |
| Result cap | DQL returns 1000 records unless a `limit` is given. Emit `SPL5006` when the SPL has no limiting command. | ref |

## 2. Diagnostic code catalogue

Severity: **E** error (no DQL for the affected part), **W** warning, **I** info. Reuse the same code for the same kind of issue; put the specifics in the message.

| Code | Sev | Meaning | Example trigger |
|---|---|---|---|
| SPL1001 | E | Syntax error (unexpected token, unterminated string, unbalanced `()`/`[]`). | `index=a \| stats count by (` |
| SPL1002 | E | Empty query or empty pipeline stage. | `index=a \| \| head 5` |
| SPL1003 | E | Command recognised, arguments malformed. Stage becomes `Unsupported`. | `timechart span= count` |
| SPL1004 | E | Expression parse error in `eval`/`where`/`stats eval()`. | `eval x = if(a,` |
| SPL1005 | E | Macro expansion failed (cycle, depth > 10, argument count mismatch). | `` `m(1)` `` defined with two args |
| SPL1006 | E | Input too large or too deeply nested (over 1,000,000 characters, 20,000 terms, 16 subsearch levels, or macro expansion past 1,000,000 characters), or a budget of ADR-029 exceeded: printed DQL over 1,000,000 characters or nested more than 1,000 deep (the translation stops), a `foreach` over 200,000 characters, a `replace` with more than 500 pairs, or a stage too large for the call stack (the stage is not translated), more than 10,000 notes (one closing note). | a 2 MB search |
| SPL1007 | E | The search has no data source DQL can start from (e.g. it starts with a transforming command). | `\| stats count` |
| SPL1008 | E | Internal error in the translator. Never expected; property tests assert it does not occur. | — |
| SPL2001 | W | Unknown command (not in the registry). | `\| mycustomcmd x` |
| SPL2002 | W | Known command with no DQL translation (T3). | `transaction … maxpause=5m` |
| SPL2003 | W | Unsupported argument or option; message says whether it was ignored or the stage was skipped. | `dedup 3 host` |
| SPL2004 | W | Unsupported `eval` function. | `printf("%d", x)` |
| SPL2005 | W | Unsupported aggregation function. | `stats mode(x)` |
| SPL2006 | W | Regex not convertible to DPL. | `rex "(?i)(?<a>x)\1"` |
| SPL2007 | W | Subsearch form not translatable. | subsearch returning two fields |
| SPL2008 | W | Side-effect command dropped. | `\| outputlookup x.csv` |
| SPL2009 | W | Wildcard in a field list / rename / template needs a schema the translator does not have. | `rename foo* AS bar*` |
| SPL2010 | W | Command depends on result row order, which DQL does not expose. | `streamstats count`, `appendcols` |
| SPL2011 | W | Real-time or index-time time modifier. | `earliest=rt-5m`, `_index_earliest=-1h` |
| SPL2012 | W | A field name holds a backtick, a carriage return or a line feed. No source confirms how DQL writes such a name inside backticks (ADR-029), so the stage is not translated. | ``rename uri AS "a`b"`` |
| SPL3001 | W | Case sensitivity differs from Splunk. | subsearch lowered to `in [ … ]` |
| SPL3002 | W | Null / missing-field handling differs. | `dedup keepempty=true` |
| SPL3003 | W | Result shape differs (wide table vs series arrays or long rows). | `timechart … by host` |
| SPL3004 | W | Depends on record order; DQL order is not guaranteed without `sort`. | `stats first(x)`, `list(x)` |
| SPL3005 | W | Exact vs approximate aggregation may differ. | `median(x)`, `perc95(x)` |
| SPL3006 | W | Type coercion differs (numeric strings, epoch seconds vs `timestamp`/`duration`). | `status=200` on an untyped field |
| SPL3007 | W | Index base adjusted from a non-literal argument; verify. | `substr(s, n, 3)` |
| SPL3008 | W | Regex converted to DPL; anchoring, greediness or capture type may differ. | any `rex` |
| SPL3009 | W | Built-in limits differ. | `join` (Splunk `max=1`), `timechart` `limit=10`/`OTHER`, `sort` 10000 |
| SPL3010 | W | Time zone, week start or time-format difference. | `strftime`, absolute `earliest` |
| SPL3011 | W | Wildcard / token matching differs. | `field="a*b"`, mid-pipeline bare term |
| SPL3012 | W | Upstream pipeline duplicated inside a sub-query (cost; the two runs may see different data). | `eventstats` strategy B |
| SPL3013 | W | Multivalue semantics differ (Splunk MV fields vs DQL arrays; lookup multi-match). | `lookup` with several matches |
| SPL3014 | W | Command approximated by a different construct. | `transaction id`, `tstats` |
| SPL3015 | W | Time range not expressible or defaulted. | `earliest=0` |
| SPL3016 | W | Output field names differ (prefix added, auto-names). | `lookup` without `OUTPUT` |
| SPL3017 | W | The generated DQL did not pass the offline syntax check. Never expected for translator output. | — |
| SPL4001 | W | `index` not in the mapping file. | `index=web` unmapped |
| SPL4002 | W | `sourcetype` not in the mapping file. | `sourcetype=access_combined` |
| SPL4003 | W | Field is neither mapped nor produced upstream; it probably relies on Splunk search-time extraction. | `stats avg(response_time)` |
| SPL4004 | W | Macro definition missing. | `` `my_filter` `` |
| SPL4005 | W | Lookup table not mapped to a Grail file path. | `lookup assets …` |
| SPL4006 | W | `eventtype`, `tag` or saved-search reference not resolvable. | `eventtype=failed_login` |
| SPL4007 | W | Metric name not mapped. | `mstats avg(cpu.pct)` |
| SPL4008 | W | Data model (or one of its datasets) has no entry under `datamodels` in the mapping file; the search is still translated, reading all records. Also used for `datamodel` without `search`/`flat` and `tstats from` a namespace. | `tstats … from datamodel=Web` |
| SPL4009 | W | Dashboard token (`$name$`, `$form.name$`, `$name\|s$`) kept as plain text; reported once per token and stage. Not reported inside `map`, which uses the same syntax for its own fields. When a dashboard is converted (dashboards.md §5) a token that became a variable is not reported; one that is only part of a value is, and so is a variable that chooses a field. | `host=$host_tok$` |
| SPL5001 | I | No time range in the SPL; DQL inherits the UI/API timeframe (default last 2 h). | no `earliest` |
| SPL5002 | I | Built-in field mapping applied. | `_raw`→`content` |
| SPL5003 | I | Null-group filter inserted before `summarize` to mirror `stats … by`. | `stats count by host` |
| SPL5004 | I | `sort timestamp desc` inserted to reproduce Splunk event order. | `… \| head 20` on raw events |
| SPL5005 | I | Macro expanded. | `` `idx` `` |
| SPL5006 | I | Splunk default limit not replicated / DQL 1000-record default applies. | `sort host` |
| SPL5007 | I | Display-only command dropped (no effect on data). | `fieldformat`, `highlight` |
| SPL5008 | I | Cost hint. | `countDistinctExact`, self-join |

## 3. Source resolution (the leading implicit `search`)

The first stage of an SPL query is an implicit `search`. It lowers to one `fetch` plus zero or more `filter` / `filterOut` stages.

### 3.1 Parsing rules that differ from `where`

| Rule | Detail | Prov |
|---|---|---|
| Precedence | In `search`: parentheses, then `NOT`, then **`OR`, then `AND`**. In `eval`/`where`: parentheses, `NOT`, `AND`, `OR`, `XOR`. `A B OR C` means `A AND (B OR C)`. Build the tree with the right table for the context and emit explicit parentheses. | spl |
| Implicit AND | Adjacent terms are `AND`. | spl |
| `XOR` | Not valid in `search`. | spl |

### 3.2 Data source and time range

| SPL | DQL | Tier | Notes | Prov |
|---|---|---|---|---|
| `index=app` (mapped) | `fetch <dataObject>, bucket:{"<bucket>"}` | T1 | Mapping file gives data object (default `logs`), bucket(s) and an optional extra filter. | ref (syntax), inf (mapping) |
| `index=a OR index=b` at top level | `fetch logs, bucket:{"<a>", "<b>"}` | T1 | Only when the OR group contains nothing but index terms. | ref |
| `index=*` | `fetch logs` | T1 | No bucket filter. | inf |
| index unmapped | `fetch logs` | T2 | Predicate dropped, `SPL4001`. Strict mode turns this into an error. | — |
| index under `NOT` or mixed `OR` | `dt.system.bucket == "<bucket>"` inside the filter expression | T2 | `SPL3014`. | inf |
| indexes mapped to different data objects | — | T3 | `SPL2003`. | — |
| no index term | `fetch logs` | T2 | Splunk searches the user's default indexes; `SPL4001` with "no index given". | — |
| `sourcetype=x` (mapped) | mapping-file filter expression | T1 | | inf |
| `sourcetype=x` (unmapped) | predicate dropped | T2 | `SPL4002`. Dropping widens the result. | — |
| `host=x` | `matchesValue(host.name, "x")` | T1 | The notebook uses `matchesPhrase` for discovery but notes it also matches longer names; `matchesValue` without wildcards is a whole-value, case-insensitive match. | nb, ref |
| `source=x` | `matchesValue(log.source, "x")` | T1 | | nb |
| `eventtype=x`, `tag=x` | predicate dropped | T2 | `SPL4006` unless the mapping file defines it. | — |
| no time modifier | no `from:`/`to:` | T1 | `SPL5001`. | ref |
| `earliest=-24h` | `from:-24h` | T1 | | ref |
| `earliest=-24h@h` | `from:-24h@h` | T1 | Offset first, then align; no space around `@`. | ref |
| `earliest=@d` | `from:@d` | T1 | `@unit` alone means `now()@unit`. | ref |
| `latest=now` | omit `to:` | T1 | | ref |
| `latest=-1h@h` | `to:-1h@h` | T1 | | ref |
| `earliest=-1d@d+2h` | `from:now()-1d@d+2h` | T2 | `SPL3015`. | inf |
| `earliest="10/27/2026:00:00:00"` | `from:"2026-10-27T00:00:00Z"` | T2 | Converted at translate time using the configured zone (default UTC); `SPL3010`. | ref (ISO strings) |
| `earliest=1700000000` | ISO string computed at translate time | T1 | | ref |
| `earliest=0` / all time | no `from:` | T2 | `SPL3015`. | — |
| `earliest=rt…`, `_index_earliest=…` | — | T3 | `SPL2011`. | — |
| time modifier under `OR`/`NOT`, or in a later `search` | — | T3 | `SPL2003`. | — |

**Time unit map**

| SPL offset unit | DQL | SPL snap | DQL snap | Prov |
|---|---|---|---|---|
| `s`, `sec`, `secs`, `second(s)` | `s` | `@s` | `@s` | ref |
| `m`, `min`, `minute(s)` | `m` | `@m` | `@m` | ref |
| `h`, `hr`, `hrs`, `hour(s)` | `h` | `@h` | `@h` | ref |
| `d`, `day(s)` | `d` | `@d` | `@d` | ref |
| `w`, `week(s)` | `w` | `@w`, `@w0`, `@w7` (Sunday) | `@w0` | ref (DQL `@w` is **Monday**; `w0`/`w7` is Sunday) |
| — | — | `@w1` … `@w6` | `@w1` … `@w6` | ref |
| `mon`, `month(s)` | `M` | `@mon` | `@M` | ref (`m` = minutes, `M` = months) |
| `q`, `qtr(s)`, `quarter(s)` | `q` | `@q` | `@q` | ref for snap; offset in `q` is `inf` |
| `y`, `yr(s)`, `year(s)` | `y` | `@y` | `@y` | ref for snap; offset in `y` is `inf` |

### 3.3 Predicates

`F` is the mapped DQL field. All forms below are case-insensitive on the value, like Splunk `search`.

| SPL (search context) | DQL expression | Tier | Notes | Prov |
|---|---|---|---|---|
| `error` (bare term) | `matchesPhrase(content, "error")` | T1 | Token match on the raw event. | nb |
| `"connection timeout"` | `matchesPhrase(content, "connection timeout")` | T1 | | nb |
| `fail*`, `*fail` | `matchesPhrase(content, "fail*")` | T2 | `SPL3011`; token boundaries differ from Splunk's segmenters. | ref (wildcard param), inf (equivalence) |
| `CASE(Error)` | `matchesPhrase(content, "Error", caseSensitive: true)` | T1 | | ref |
| `TERM(a.b.c)` | `matchesPhrase(content, "a.b.c")` | T2 | `SPL3011`. | inf |
| `f=value` | `matchesValue(F, "value")` | T1 | Whole value. Use `==` only for a case-sensitive match. | nb, ref |
| `f="va*"`, `f="*err*"` | `matchesValue(F, "va*")` | T1 | Leading/trailing `*`. | ref |
| `f="a*b"` (mid-string) | `matchesValue(F, "a*b")` | T2 | `SPL3011`; the two local references disagree on mid-string wildcards (§9). | inf |
| `f=*` | `isNotNull(F)` | T1 | | inf |
| `f!=value` | `not matchesValue(F, "value")` | T1 | A record without `f` yields null and is dropped, as in Splunk. | nb |
| `NOT f=value` (top-level conjunct) | stage `filterOut matchesValue(F, "value")` | T1 | Keeps records without `f`, as in Splunk. | nb |
| `NOT p` (nested) | `isFalseOrNull(<p>)` | T1 | Same truth table as `filterOut`. | ref (function), inf (use) |
| `f IN (a, b*)` | `matchesValue(F, {"a", "b*"})` | T1 | The notebook uses `in(F, {…})`, which is case-sensitive and has no wildcards. Values may be written without spaces: `("a","b")`. | ref |
| `f IN (500, 502)` (only unquoted numbers) | `in(F, {500, 502})` | T1 | Same rule as `f=500`: compared as numbers unless `F` is declared as text; `SPL3006` when `F` has no declared type. | ref |
| `f>10`, `>=`, `<`, `<=` | `F > 10` | T1 / T2 | T2 with `SPL3006` when the mapping file does not type `F`. | ref |
| `f=200` (numeric literal) | mapped numeric: `F == 200` · mapped string: `matchesValue(F, "200")` · unknown: `F == 200` + `SPL3006` | T1 / T2 | `matchesValue` does not accept numeric fields. | ref (signature), inf (policy) |
| `A B`, `A AND B` | `(<A>) and (<B>)` | T1 | | ref |
| `A OR B` | `(<A>) or (<B>)` | T1 | | ref |
| `[ search … ]` | see §4.9 | | | |

**Emission.** Lower the whole search expression to one boolean expression. Then, for readability and to match the notebook's forms: emit each top-level conjunct of the shape `isFalseOrNull(p)` as its own `filterOut p` stage, and all remaining conjuncts as one `filter`.

**Tri-state logic.** DQL comparisons with a null operand yield null, and `filter` keeps only `true`. This is what makes `!=` drop missing fields and `filterOut` keep them. (ref)

**Mid-pipeline `search`** (after a transforming command): field predicates lower as above. A bare term has no `content` to match, so emit the DQL `search "term"` command, which matches tokens across all fields (T2, `SPL3011`). (ref)

### 3.4 Case-sensitivity summary

| Context | Splunk | Emitted DQL | Prov |
|---|---|---|---|
| `search` field value, bare term | insensitive | `matchesValue` / `matchesPhrase` (insensitive by default) | nb, ref |
| `where` / `eval` `=`, `==`, `!=` | sensitive | `==`, `!=` (sensitive) | nb |
| `like()`, `match()` | sensitive | `like()` / DPL | inf |
| `stats by`, `dedup`, `join` keys | sensitive | native equality | inf |
| `lookup` key | sensitive by default | native equality | inf |
| subsearch-as-filter | insensitive | `in [ … ]` is exact → `SPL3001` | ref |

## 4. Command matrix

Templates omit the leading pipe. `…` means "the lowered sub-expression". Tier is best case.

### 4.1 Filtering and expressions

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `search <expr>` | T1 | `filter …` / `filterOut …` | §3 | Search precedence. | nb, ref |
| `where <expr>` | T1 | `filter <expr>` | all | Eval precedence; `where a=b` with an unquoted right side compares two **fields**. | spl, ref |
| `eval a=x, b=y` | T1 | `fieldsAdd a = <x>, b = <y>` | all | If a later assignment references an earlier target, split into separate `fieldsAdd` stages. | ref; same-stage visibility is `inf` |
| `regex f="re"` / `f!="re"` | T2 | `filter matchesPattern(F, "<DPL>")` / `filter not matchesPattern(…)` | default field `_raw`→`content` | Regex→DPL per §7, wrapped so it matches anywhere; `SPL3008`. Not convertible → T3 `SPL2006`. | inf |
| `fieldformat`, `highlight`, `iconify` | T1 | (dropped) | — | `SPL5007`. | — |

### 4.2 Field shaping

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `table a, b` | T1 | `fields a, b` | wildcard → `fieldsKeep "a*"` (T2, `SPL2009` if order matters) | | nb, ref |
| `fields a, b` / `fields + a, b` | T1 | `fieldsKeep a, b, timestamp, content` | | Splunk keeps `_time` and `_raw` unless removed; skip the two extras after a transforming command. | ref, spl |
| `fields - a, b` | T1 | `fieldsRemove a, b` | `fields - _*` → `SPL2009` | | ref |
| `rename a AS b, c AS "d e"` | T1 | ``fieldsRename b = a, `d e` = c`` | wildcards → T3 `SPL2009` | Syntax is `new = old`. The notebook's `fieldsRename old, alias:new` matches neither reference; do not emit it. | ref |
| `fillnull value=X a b` | T1 | `fieldsAdd a = coalesce(a, X), b = coalesce(b, X)` | default value `0`; no field list → T3 `SPL2009` | | ref |
| `replace "x" WITH "y" IN f` | T1 | `fieldsAdd f = if(f == "x", "y", else: f)` | wildcards → `SPL2009`; no `IN` → `SPL2003`; more than 500 pairs → T3 `SPL1006` | | ref |
| `convert ctime(f) AS g` | T2 | `fieldsAdd g = formatTimestamp(timestampFromUnixSeconds(toLong(f)), format: "MM/dd/yyyy HH:mm:ss")` | `num()`, `auto()` → `toDouble(f)`; `timeformat=` via §6.4; `dur2sec`, `memk`, `rmunit`, `rmcomma`, `mktime`, `mstime` → `SPL2003` | `SPL3010`. | ref, inf |
| `addtotals fieldname=T a b` | T2 | `fieldsAdd T = coalesce(a, 0) + coalesce(b, 0)` | no field list → needs known schema; `col=true`, `addcoltotals` → T3 | | inf |
| `foreach a b c [eval …<<FIELD>>…]` | T2 | one `fieldsAdd` per listed field | wildcard list → `SPL2009` unless schema known | Template expansion at translate time. Fields × template length over 200,000 characters → T3 `SPL1006` (ADR-029). | — |

### 4.3 Aggregation

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `stats <aggs> by k1, k2` | T1 | `filter isNotNull(k1) and isNotNull(k2)` then `summarize {a = …, b = …}, by:{k1, k2}` | functions per §5; `partitions`, `allnum`, `delim` ignored with `SPL2003` | Splunk drops events whose by-field is null; DQL keeps a null group. `SPL5003`. | spl, ref |
| `stats <aggs>` | T1 | `summarize {a = …}` | | | ref |
| `chart <aggs> by a` / `over a` | T1 | as `stats … by a` | `span=`/`bins=` on the over-field → `by:{a = bin(a, N)}` | | ref |
| `chart <aggs> over a by b` | T2 | `summarize …, by:{a, b}` | `limit`, `useother`, `usenull` → `SPL3009` | Long rows, not Splunk's pivoted columns: `SPL3003`. | inf |
| `timechart span=5m <aggs> by s` | T2 | see below | see below | `SPL3003`. | nb, ref |
| `top limit=N f` | T1 | see below | `countfield`, `percentfield`, `showcount`, `showperc` supported; `useother` → `SPL2003` | default `N` = 10 | ref |
| `top f by g` | T2 | `summarize count = count(), by:{g, f}` then `sort g asc, count desc` | | No per-group limit: `SPL3014`. | inf |
| `rare f` | T1 | as `top`, `sort count asc` | as `top` | | ref |
| `eventstats <aggs> by k` | T2 | see below | | `SPL3012` (strategy B). | ref, inf |
| `streamstats …` | T3 | — | T2 only for the array forms below | `SPL2010`. | — |
| `transaction k` | T2 | see below | any of `maxspan`, `maxpause`, `startswith`, `endswith`, `maxevents`, `keepevicted` → T3 `SPL2002` | `SPL3014`. | inf |

**`timechart`** — two lowerings:

```dql
// (a) series mode: timechart is the last data command
| makeTimeseries count = count(default: 0), by:{host.name}, interval:5m

// (b) tabular mode: later stages need one row per bucket, or an aggregation
//     makeTimeseries does not support
| summarize count = count(), by:{timestamp = bin(timestamp, 5m), host.name}
```

| Aspect | Rule | Prov |
|---|---|---|
| Mode choice | (a) when nothing row-oriented follows and every function is in the `makeTimeseries` set (`sum`, `avg`, `min`, `max`, `median`, `percentile`, `count`, `countIf`, `countDistinctExact`, `countDistinctApprox`). Otherwise (b). | ref |
| Zero fill | `count(default: 0)` and `countIf(…, default: 0)` mirror Splunk's zero-filled empty buckets. Mode (b) has no rows for empty buckets: `SPL3003`. | ref |
| `span=` | `interval:5m`. No `span` → omit (DQL picks ~120 bins, Splunk ~100). `makeTimeseries` may silently coarsen an unsupported interval (the notebook measured `4m`→`5m`). | nb, ref |
| `span=1mon` / `1q` / `1y` | mode (b) with `by:{timestamp = timestamp@M}` (`@q`, `@y`). | ref |
| `bins=N` | `bins:N`. | ref |
| `by` | `by:{s}`. Splunk's `limit=10` + `OTHER` and `usenull` are not reproduced: `SPL3009`. | — |
| `per_second(x)`, `per_minute`, `per_hour`, `per_day` | `sum(x, rate: 1s)` (`1m`, `1h`, `1d`), mode (a) only. | ref (param), inf (equivalence) |
| `cont`, `partial`, `fixedrange`, `aligntime` | ignored, `SPL2003`. | — |

**`top`** (percent via the reference's collect-and-expand pattern):

```dql
| filter isNotNull(f)
| summarize count = count(), by:{f}
| summarize {_r = collectArray(record(f, count)), _total = sum(count)}
| expand _r
| fields f = _r[f], count = _r[count], percent = 100.0 * _r[count] / _total
| sort count desc
| limit 10
```

With `showperc=f` drop the middle three stages.

**`eventstats`** — pick by what is known about the incoming schema:

```dql
// Strategy A (schema known, e.g. after stats/table): no re-execution
| summarize {_rows = collectArray(record(k, x, y)), a = avg(x)}, by:{k}
| expand _rows
| fields k, x = _rows[x], y = _rows[y], a

// Strategy B (schema unknown): self-join, upstream pipeline duplicated
| join [ <upstream pipeline> | summarize a = avg(x), by:{k} ],
    on:{k}, kind:leftOuter, fields:{a}
```

Without `by`, strategy A drops the `by:`; strategy B adds a constant key on both sides (`fieldsAdd _k = 1`). Strategy A is bounded by `collectArray` size limits (`inf`).

**`streamstats` and friends, T2 array forms** (only directly after a series-mode `timechart`):

| SPL | DQL | Prov |
|---|---|---|
| `streamstats sum(x) as c` / `accum x as c` | `fieldsAdd c = arrayCumulativeSum(x)` | ref |
| `streamstats window=N sum(x)` (`avg`, `min`, `max`) | `fieldsAdd c = arrayMovingSum(x, N)` (`arrayMovingAvg`, `arrayMovingMin`, `arrayMovingMax`) | ref; the notebook reports a maximum window of 60 and partial sums for the first N−1 points |
| `delta x as d` | `fieldsAdd d = arrayDelta(x)` | ref; `arrayDelta` vs `arrayDiff` choice is `inf` |
| `trendline sma5(x) as t` | `fieldsAdd t = arrayMovingAvg(x, 5)` | ref |

**`transaction k`** (no options):

```dql
| summarize {_start = min(timestamp), _end = max(timestamp), eventcount = count(),
             content = collectArray(content)}, by:{k}
| fieldsAdd duration = (_end - _start) / 1s, timestamp = _start
```

### 4.4 Ordering and limiting

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `sort a, -b` | T1 | `sort a asc, b desc` | `num(f)`→`toDouble(f)`, `str(f)`→`toString(f)`, `ip(f)`→`toIp(f)`; trailing `desc`/`d` flips all | Splunk's `auto` picks numeric vs lexical per field; DQL sorts by stored type (`SPL3006` on untyped fields). | ref, inf |
| `sort N a` | T1 | `sort a asc` then `limit N` | | | ref |
| `sort a` (no count) | T1 | `sort a asc` | | Splunk truncates at 10000; not replicated, `SPL5006`. | spl |
| `sort 0 a` | T1 | `sort a asc` | | | spl |
| `head N` | T1 | `limit N` (default 10) | `head <expr>`, `keeplast`, `null` → T3 | On raw events with no prior sort, prepend `sort timestamp desc` (`SPL5004`); Splunk returns newest first, DQL order is unspecified. | ref, inf |
| `tail N` | T2 | directly after `sort` or `reverse`: the opposite sort, then `limit N` (the last N rows of a sorted result, in Splunk's tail order); otherwise on raw events `sort timestamp asc` then `limit N` | | After a transforming command without a sort → T3 `SPL2010`. | inf |
| `reverse` | T2 | raw events: `sort timestamp asc`; directly after `sort`: flip every direction | | Elsewhere T3 `SPL2010`. A following `tail` or `reverse` sees the flipped order. | inf |
| `dedup a, b` | T1 | `filter isNotNull(a) and isNotNull(b)` then `dedup a, b, sort:{timestamp desc}` | `sortby -f` → `sort:{f desc}`; `keepempty=true` → omit the filter + `SPL3002` (Splunk keeps *all* null events, DQL one); `N`, `consecutive`, `keepevents` → T3 `SPL2003` | The `sort:` keeps the newest event, as Splunk does on raw events. Omit it after a transforming command (`SPL3004`). | nb, ref |
| `uniq` | T2 | `dedup <all known fields>` | schema unknown → T3 | | inf |

### 4.5 Extraction

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `rex field=f "…(?<n>…)…"` | T2 | `parse F, "<DPL>"` | `field` default `_raw`→`content`; `max_match≠1`, `offset_field` → T3 `SPL2003` | §7. One `parse` per `rex`; lead with `DATA?` unless the regex starts with `^`. `SPL3008`. | nb, ref |
| `rex mode=sed "s/a/b/g"` | T2 | literal: `fieldsAdd F = replaceString(F, "a", "b")` · regex: `fieldsAdd F = replacePattern(F, "<DPL>", "b")` | no `g` flag → `SPL3008` (DQL replaces every match); back-references → `SPL2006`; `y/…/` → `SPL2003` | | ref |
| `spath` (no args) | T2 | `parse content, "JSON:json"` then `fieldsFlatten json` | | Field names differ from Splunk's `a.b{}.c`: `SPL3016`. | ref, inf |
| `spath input=f path=a.b output=x` | T2 | `fieldsAdd x = jsonPath(F, "$.a.b")` | `a{}.b`→`$.a[*].b` | `SPL3013`. | ref; wildcard path is `inf` |
| `extract` / `kv`, `xmlkv`, `multikv` | T3 | — | | Search-time extraction; use `parse` with `KVP{…}` by hand. | — |

Fields that Splunk extracts automatically at search time (`key=value` pairs, JSON keys) do not exist in Grail unless parsed at ingest. When a query uses a field that is neither mapped nor produced upstream, emit `SPL4003`; do not invent a `parse`. (nb)

### 4.6 Enrichment and combination

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `lookup t k OUTPUT a, b AS c` | T2 | `lookup [load "<path>"], sourceField: k, lookupField: k, fields:{a, c = b}` | `k AS local` → `sourceField: local`; several keys → `join` form; `OUTPUTNEW` → `fields:{_n = a}` + `coalesce(a, _n)` | Path from mapping file (`SPL4005`). Multiple matches: Splunk returns MV, DQL one row (`SPL3013`). | ref |
| `lookup t k` (no `OUTPUT`) | T2 | `lookup [load "<path>"], sourceField: k, lookupField: k` | | Columns arrive as `lookup.<col>` unless the mapping file lists them (then emit `fields:{…}`): `SPL3016`. A second `lookup` with the default prefix wipes the first one's fields; always use `fields:` or a distinct `prefix:` when chaining. | ref |
| `inputlookup t [where …]` | T2 | `load "<path>"` then `filter …` | `append=true` → `append [load "<path>"]` | `SPL4005` if unmapped. | ref |
| `join type=inner k [sub]` | T2 | `join [<sub>], on:{k}, kind:inner, fields:{<sub's output fields>}` | `type=left`/`outer` → `kind:leftOuter`; differing key names → ``on:{left[a] == right[b]}``; `usetime`, `earlier`, `overwrite` → `SPL2003` | Splunk keeps one match per row by default (`max=1`), DQL keeps all: `SPL3009`. If the sub-pipeline's output fields are not statically known, omit `fields:` and accept the `right.` prefix (`SPL3016`). | ref |
| `append [sub]` | T1 | `append [<sub>]` | `extendtimerange`, `maxtime`, `maxout` ignored | | ref |
| `union [a] [b]`, `multisearch [a] [b]` | T2 | `<a>` then `append [<b>]` | | Interleaving/order not preserved: `SPL3004`. | inf |
| `appendcols [sub]` | T3 | — | | Positional paste, `SPL2010`. | — |

### 4.7 Multivalue

| SPL | Tier | DQL template | Arguments | Notes | Prov |
|---|---|---|---|---|---|
| `mvexpand f` | T1 | `expand f` | `limit=N` → `expand f, limit:N` | `f` must be an array. | ref |
| `makemv delim="," f` | T1 | `fieldsAdd f = splitString(f, ",")` | default delimiter is a space; `tokenizer=` → T3; `allowempty` ignored | | ref |
| `mvcombine f` | T2 | `summarize f = collectArray(f), by:{<all other known fields>}` | schema unknown → T3 `SPL2009` | Array order not guaranteed: `SPL3004`. | ref |
| `nomv f` | T1 | `fieldsAdd f = arrayToString(f, delimiter: "\n")` | | | ref |

### 4.8 Generating, metrics, and commands with no translation

| SPL | Tier | DQL template | Notes | Prov |
|---|---|---|---|---|
| `makeresults` | T2 | `data record(timestamp = now())` | `count=N>1` → `SPL2003`. | ref |
| `tstats <aggs> where <search> by k _time span=1h` | T2 | `fetch …` + `filter …` + `filter isNotNull(k)` + `summarize …, by:{k, timestamp = bin(timestamp, 1h)}` | Runs on events, not index summaries: `SPL3014`. `tstats` leaves out rows with an empty BY field, so the same null guard as `stats` is emitted (`SPL5003`). `span=` may stand anywhere in the BY list. `min/max/earliest/latest(_time)` stay typed as time (§6.3). `append=`, `from <namespace>`, `from sid=` → T3. | spl, inf |
| `tstats fillnull_value=V … by k` | T2 | `fieldsAdd k = coalesce(k, "V")` before `summarize`, instead of the null guard | Splunk substitutes `V` for an empty BY field. | spl |
| `tstats summariesonly=… allow_old_summaries=… local=… chunk_size=… include_reduced_buckets=…` | T2 | ignored | They steer Splunk's summaries; the events read are the same. | spl |
| `tstats <aggs> from datamodel=M[.D] [where nodename=M.D …] by D.f` | T2 | `fetch` from the data model's mapping entry, its `filter`, then as above with `D.f` resolved as a data-model field | mapping-config.md → Data models. `SPL4008` when the model or dataset has no entry. | spl, inf |
| `tstats prestats=t … \| timechart …` (or `stats`, `chart`) | T2 | `fetch` + `filter` only; the next command aggregates | `prestats=t` hands partial results to the next reporting command, which states the aggregation again; the result equals that command run on the events. | spl |
| `mstats avg(m) WHERE … span=1m BY h` | T2 | `timeseries a = avg(<metric.key>), by:{H}, interval:1m` | Metric key from mapping file (`SPL4007`). Result is series arrays: `SPL3003`. `percentile`/`median` need `rollup:`. | ref |
| `datamodel M D search`, `datamodel M D flat` | T2 | `fetch` from the mapping entry of `M.D` | Without `search`/`flat` it returns the model's definition, not events: T3 `SPL4008`. | spl |
| `from datamodel:M.D` | T2 | `fetch` from the mapping entry of `M.D` | `from savedsearch:` and other datasets → T3 `SPL4006`. | spl |
| `rename D.* as *`, `` `drop_dm_object_name(D)` `` after a data-model search | T1 | nothing | The dataset prefix is never carried into DQL. `SPL5007`. | spl |
| `pivot` | T3 | — | Builds a report from a data model definition; write it with `stats`. `SPL2002`. | — |
| `iplocation f` | T3 | — | No geo-IP function in the reference. `SPL2002`. | ref (absence) |
| `map` | T3 | — | Per-row sub-search. `SPL2002`. | — |
| `collect`, `outputlookup`, `outputcsv`, `sendemail`, `sendalert`, `delete` | T3 | (dropped) | `SPL2008`. | — |
| `predict`, `anomalydetection`, `cluster`, `kmeans`, `geostats`, `rest`, `metadata`, `dbinspect`, `loadjob`, `script` | T3 | — | `SPL2002`. | — |

### 4.9 Macros and subsearches

**Macros** are expanded textually before parsing.

| Case | Behaviour |
|---|---|
| `` `name` ``, `` `name(a, "b c")` `` | Look up `name` or `name(<argc>)` in the mapping file; substitute `$arg$` placeholders; re-scan up to depth 10. `SPL5005`. |
| Definition missing | `SPL4004`. If the macro is a whole pipeline stage → `Unsupported` stage. If it sits inside a search expression → dropped from the expression. |
| Cycle, depth, arity mismatch | `SPL1005`. |

**Subsearches**

| SPL | Tier | DQL | Notes | Prov |
|---|---|---|---|---|
| `… [search … \| fields f]` (also `table f`, `return f`, `return N f`) | T2 | `F in [ <sub> \| fields F ]` | Exact, case-sensitive match: `SPL3001`. Splunk caps subsearch rows/time, DQL caps at 128 MB: `SPL3009`. Plain `return f` keeps only the first row; emit `limit 1` in the block. | ref |
| `NOT [search … \| fields f]` | T2 | `isFalseOrNull(F in [ … ])` | | inf |
| `[ \| inputlookup t \| fields f ]` | T2 | `F in [ load "<path>" \| fields F ]` | | ref |
| subsearch returning several fields, `format` | T3 | — | `SPL2007`. | — |
| subsearch as argument of `join`/`append`/`union` | — | execution block `[ … ]` | See §4.6. | ref |

## 5. Aggregation functions (`stats`, `chart`, `timechart`, `eventstats`, `top`)

`mT` = also valid inside `makeTimeseries` (series mode).

| SPL | DQL | mT | Notes | Prov |
|---|---|---|---|---|
| `count`, `c` | `count()` | yes | | ref |
| `count(f)` | `countIf(isNotNull(f))` | yes | On a multivalue field Splunk counts values, DQL records: `SPL3013`. | ref, inf |
| `count(eval(<cond>))` | `countIf(<cond>)` | yes | | nb, ref |
| `dc(f)`, `distinct_count(f)` | `countDistinctExact(f)` | yes | `SPL5008`. Null handling is `inf`. | ref |
| `estdc(f)` | `countDistinctApprox(f)` | yes | | ref |
| `sum(f)` | `sum(f)` | yes | | ref |
| `avg(f)`, `mean(f)` | `avg(f)` | yes | | ref |
| `min(f)`, `max(f)` | `min(f)`, `max(f)` | yes | Both sides accept strings. | ref |
| `range(f)` | `max(f) - min(f)` | no | Not valid as a single aggregation in mT; use tabular mode. | ref |
| `median(f)` | `median(f)` | yes | `SPL3005`. | ref |
| `perc95(f)`, `p95(f)` | `percentile(f, 95)` | yes | `SPL3005`. No `rollup:` here. | ref |
| `exactperc95(f)` | `percentile(f, 95)` | yes | `SPL3005`. | inf |
| `upperperc95(f)` | — | | `SPL2005`. | — |
| `stdev(f)` | `stddev(f)` | no | Sample vs population is `inf`. | ref |
| `stdevp(f)` | `stddev(f)` | no | `SPL3005`. | inf |
| `var(f)`, `varp(f)` | `variance(f)` | no | As `stdev`. | ref, inf |
| `sumsq(f)` | `sum(f * f)` | yes | | ref |
| `values(f)` | `arraySort(collectDistinct(f))` | no | Splunk returns sorted distinct values. | ref |
| `list(f)` | `collectArray(f)` | no | Splunk keeps event order and caps at 100; DQL order is not guaranteed: `SPL3004`. | ref |
| `first(f)` | `takeFirst(f)` | no | Order-dependent: `SPL3004`. On raw events insert `sort timestamp desc` first. | ref, inf |
| `last(f)` | `takeLast(f)` | no | As `first`. | ref, inf |
| `earliest(f)` | `sort timestamp asc` before, then `takeFirst(f)` | no | `SPL3004`. | inf |
| `latest(f)` | `sort timestamp asc` before, then `takeLast(f)` | no | `SPL3004`. | inf |
| `earliest(_time)`, `latest(_time)` | `min(timestamp)`, `max(timestamp)` | no | The earliest/latest value of the event time is its minimum/maximum, so no sort and no `SPL3004`. | ref |
| `earliest_time(f)`, `latest_time(f)` | `min(timestamp)`, `max(timestamp)` | yes | `timestamp`, not epoch seconds: `SPL3006`. | ref |
| `mode(f)` | — | | `SPL2005`. | — |
| `rate(f)` | — | | `SPL2005` outside `mstats`. | — |
| `per_second(f)` … `per_day(f)` | `sum(f, rate: 1s)` … `rate: 1d` | yes | `timechart` only. | ref, inf |
| `sparkline(…)` | — | | `SPL2005`. | — |
| `agg(eval(<expr>))` | `agg(<expr>)` | | | ref |

When one `stats` mixes `first`/`last` with `earliest`/`latest`, sort ascending once and swap: `first`→`takeLast`, `last`→`takeFirst`.

## 6. `eval` / `where` expressions

### 6.1 Operators and literals

| SPL | DQL | Notes | Prov |
|---|---|---|---|
| `=`, `==` | `==` | Null operand → null. | ref |
| `!=` | `!=` | | ref |
| `<`, `<=`, `>`, `>=` | same | Numeric strings are not coerced: `SPL3006` on untyped fields. | ref |
| `AND`, `OR`, `NOT`, `XOR` | `and`, `or`, `not`, `xor` | Tri-state logic. | ref |
| `+`, `-`, `*`, `%` | same | Splunk `+` also concatenates two strings; emit `concat` when both operands are known strings. | ref, inf |
| `a / b` | `a / 1024.0`, `5.0 / b`, else `toDouble(a) / b` | Splunk always divides with a fraction (`5/2` = 2.5). DQL returns a `long` and drops the fraction when both operands are `long` (docs.dynatrace.com → DQL operators, division table), so one side is made a double: a whole-number literal gets `.0`; with no literal the left side is wrapped in `toDouble()`. Nothing is added when a side is already a double (a decimal literal, `toDouble()`, another division, a time difference `/ 1s`). | ref |
| `<time> * n`, `<time> / n`, `<time> % n` | `unixSecondsFromTimestamp(<t>) * n` … | A DQL timestamp cannot be multiplied or divided; a Splunk time is a number of seconds (§6.3). | ref |
| `a . b` | `concat(a, b)` | `concat` takes strings and numbers only; wrap other types in `toString()`. Null propagation is `inf`. | ref |
| `f IN ("a", "b")` | `in(f, {"a", "b"})` | Case-sensitive in `where`. | ref |
| `f LIKE "a%"` | `like(f, "a%")` | | ref |
| `"text"` | `"text"` | | ref |
| `'field name'` | `` `field name` `` | Field reference. | spl, ref |
| `true()`, `false()`, `null()` | `true`, `false`, `null` | | ref |

### 6.2 Functions

| SPL | DQL | Notes | Prov |
|---|---|---|---|
| `if(c, a, b)` | `if(c, a, else: b)` | `else:` is a named parameter. Null condition takes the else branch on both sides. | ref |
| `case(c1, v1, c2, v2, …)` | `if(c1, v1, else: if(c2, v2, else: …))` | A final `true()` / `1=1` condition becomes the last `else:`. Prefer nested `if` over the `coalesce` chain: the chain falls through when a matched value is null. | ref |
| `coalesce(a, b)` | `coalesce(a, b)` | | ref |
| `nullif(a, b)` | `if(a == b, null, else: a)` | | ref |
| `isnull(x)`, `isnotnull(x)` | `isNull(x)`, `isNotNull(x)` | | ref |
| `isnum(x)`, `isint(x)`, `isstr(x)`, `isbool(x)` | `in(type(x), {"long", "double"})`, `type(x) == "long"`, `type(x) == "string"`, `type(x) == "boolean"` | Splunk tests the *value*, DQL the stored type: `SPL3006`. | ref, inf |
| `typeof(x)` | `type(x)` | Different type names: `SPL3006`. | ref |
| `len(s)` | `stringLength(s)` | UTF-16 code units. | ref |
| `lower(s)`, `upper(s)` | `lower(s)`, `upper(s)` | | ref |
| `trim(s)` | `trim(s)` | With a character-set argument → `SPL2004`. | ref |
| `ltrim(s)`, `rtrim(s)` | — | `SPL2004`. | ref (absence) |
| `substr(s, start)` | `substring(s, from: start - 1)` | **Splunk is 1-based, DQL 0-based.** Fold literals at translate time. Negative `start` → `from: start` unchanged. | ref |
| `substr(s, start, len)` | `substring(s, from: start - 1, to: start - 1 + len)` | `to:` is exclusive. Negative `start`: `to: start + len`, omitted when that is ≥ 0. Non-literal arguments: `SPL3007`. | ref |
| `replace(s, "re", "r")` | literal: `replaceString(s, "re", "r")` · regex: `replacePattern(s, "<DPL>", "r")` | Splunk's second argument is a regex. `\1` back-references → `SPL2006`. | ref |
| `split(s, d)` | `splitString(s, d)` | | ref |
| `mvindex(m, i)` | `m[i]` | Both 0-based; negative index from the end. | ref |
| `mvindex(m, a, b)` | `arraySlice(m, from: a, to: b + 1)` | Splunk's end is inclusive. `b = -1` → omit `to:`. Non-literal: `SPL3007`. | ref |
| `mvcount(m)` | `arraySize(m)` | Splunk returns 1 for a single value; DQL needs an array: `SPL3013`. | ref, inf |
| `mvjoin(m, d)` | `arrayToString(m, delimiter: d)` | | ref |
| `mvappend(a, b)` | `arrayConcat(toArray(a), toArray(b))` | | ref, inf |
| `mvdedup(m)`, `mvsort(m)` | `arrayDistinct(m)`, `arraySort(m)` | | ref |
| `mvfilter(<cond on m>)` | `arrayRemoveNulls(iCollectArray(if(<cond on m[]>, m[])))` | | ref |
| `mvfind`, `mvzip`, `mvrange`, `mvmap` | — | `SPL2004`. | — |
| `tostring(x)` | `toString(x)` | | ref |
| `tostring(x, "hex")` | `concat("0x", numberToHexString(x))` | | ref, inf |
| `tostring(x, "commas")`, `"duration"` | — | `SPL2004`. | — |
| `tonumber(s)` | `toDouble(s)` | | ref |
| `tonumber(s, 16)` | `hexStringToNumber(s)` | Other bases → `SPL2004`. | ref |
| `round(x)` / `round(x, n)` | `round(x)` / `round(x, decimals: n)` | Negative `n` → `SPL2004`. | ref |
| `floor`, `ceil`/`ceiling`, `abs`, `sqrt`, `exp` | `floor`, `ceil`, `abs`, `sqrt`, `exp` | | ref |
| `pow(x, y)` | `power(x, y)` | | ref |
| `ln(x)` | `log(x)` | **DQL `log` is the natural log.** | ref |
| `log(x)` | `log10(x)` | Splunk's default base is 10. | ref, spl |
| `log(x, b)` | `log(x) / log(b)` | | ref |
| `pi()` | `pi()` | | ref |
| `exact(x)` | `x` | | — |
| `sigfig(x)`, `printf(…)` | — | `SPL2004`. | — |
| `max(a, b, …)`, `min(a, b, …)` (in `eval`) | `arrayMax(array(a, b))`, `arrayMin(array(a, b))` | Non-numeric elements are ignored in DQL: `SPL3006`. | ref |
| `random()` | `toLong(random() * 2147483647)` | Range of DQL `random()` is `inf`. | ref, inf |
| `like(s, "a%_")` | `like(s, "a%_")` | | ref |
| `match(s, "re")` | `matchesPattern(s, "<DPL>")` | §7. Not convertible → `SPL2006`. `SPL3008`. | inf |
| `searchmatch("…")` | lowered search expression (§3.3) | `SPL3011`. | inf |
| `cidrmatch("10.0.0.0/8", ip)` | `ipIn(ip, "10.0.0.0/8")` | Argument order swaps. | ref |
| `in(f, "a", "b")` | `in(f, {"a", "b"})` | | ref |
| `md5(s)`, `sha1(s)`, `sha256(s)`, `sha512(s)` | `hashMd5(s)`, `hashSha1(s)`, `hashSha256(s)`, `hashSha512(s)` | Hex letter case is `inf`. | ref |
| `urldecode(s)` | `decodeUrl(s)` | | ref |
| `spath(s, "a.b")`, `json_extract(s, "a.b")` | `jsonPath(s, "$.a.b")` | | ref |
| `validate(…)` | — | `SPL2004`. | — |

### 6.3 Time values

Splunk's `_time`, `now()` and friends are epoch **seconds** (numbers). DQL has `timestamp` and `duration` types, and arithmetic between them is typed. The expression lowerer tracks a static type (`time`, `number`, `string`, `unknown`) and applies these rules:

| SPL | DQL | Notes | Prov |
|---|---|---|---|
| `_time` | `timestamp` | | nb, ref |
| `now()`, `time()` | `now()` | `now()` is fixed at query start. | ref |
| `<time> - <time>` | `(<a> - <b>) / 1s` | Timestamp difference is a duration; dividing by `1s` gives seconds as a double. | ref |
| `min`, `max`, `first`, `last`, `earliest`, `latest` of a time field; `earliest_time()`, `latest_time()` | the result column is typed `time` | So `stats max(_time) as last \| eval age=now()-last` becomes `(now() - last) / 1s`, and `strftime(last, …)` formats the timestamp directly. Applies to `stats`, `chart`, tabular `timechart` and `eventstats`. | ref |
| `<time> ± <number>` | `<a> ± (<n> * 1s)` | Fold literals: `_time + 3600` → `timestamp + 3600s`. | ref |
| `<time>` compared to a number literal | fold the literal to an ISO timestamp, else `unixSecondsFromTimestamp(<a>) > n` | `SPL3006`. | ref, inf |
| `relative_time(t, "-1d@d")` | `<t> - 1d@d` | Units per §3.2. | ref |
| `strftime(t, "<fmt>")` | `formatTimestamp(<t>, format: "<java>")` | §6.4. Splunk formats in the user's zone; DQL's default zone is `inf`: `SPL3010`. A numeric `t` is wrapped in `timestampFromUnixSeconds(toLong(t))`. | ref |
| `strftime(t, "%s")` | `unixSecondsFromTimestamp(<t>)` | | ref |
| `strptime(s, "<fmt>")` | `parse(s, "TIMESTAMP('<java>'):t")` | ISO-8601 input may use `toTimestamp(s)`. `SPL3010`. The format is written as a DPL literal like any other (§7): a backslash before every quote and every backslash in it, so a format cannot end the literal early. | ref (matcher, quote escape), inf (function form, backslash escape) |
| `date_hour`, `date_minute`, `date_mday`, `date_month`, `date_year`, `date_wday` | `getHour(timestamp)`, `getMinute`, `getDayOfMonth`, `getMonth`, `getYear`, `getDayOfWeek` | Numbers, not Splunk's strings; zone differs: `SPL3010`. | ref |

### 6.4 `strftime` → DQL format letters

| Splunk | DQL | Splunk | DQL | Splunk | DQL |
|---|---|---|---|---|---|
| `%Y` | `yyyy` | `%H` | `HH` | `%b` | `MMM` |
| `%y` | `yy` | `%I` | `hh` | `%B` | `MMMM` |
| `%m` | `MM` | `%M` | `mm` | `%a` | `EEE` |
| `%d` | `dd` | `%S` | `ss` | `%A` | `EEEE` |
| `%e` | `d` | `%p` | `a` | `%j` | `DDD` |
| `%F` | `yyyy-MM-dd` | `%T` | `HH:mm:ss` | `%z` | `Z` |
| `%3N`, `%Q` | `SSS` | `%Z` | `z` | literal text | wrap in `'…'` |

Any other directive → `SPL2004`. The letter set is confirmed for the DPL `TIMESTAMP` matcher (ref); its use in `formatTimestamp` is `inf` beyond the letters shown in Dynatrace's own examples (`y`, `M`, `d`, `H`, `m`, `E`, `w`, `VV`).

## 7. Regex → DPL (`rex`, `regex`, `match`, `replace`, `mode=sed`)

DPL is not regex. Only a restricted subset converts deterministically. Everything converted carries `SPL3008`.

### 7.1 Convertible subset

| Regex | DPL | Notes | Prov |
|---|---|---|---|
| literal text | `'text'` | Escape `'`. Un-escape regex escapes (`\.` → `.`). | ref |
| `[abc]`, `[a-z0-9]`, `[^,]` | same | DPL character groups use regex class syntax and match one character by default. | ref |
| `\d`, `\w`, `\s` | `[0-9]`, `[a-zA-Z0-9_]`, `[ \t\r\n]` | | ref |
| `[\d.]`, `[\w-]`, `[^\s"]` | `[0-9.]`, `[a-zA-Z0-9_-]`, `[^ \t\r\n"]` | A shorthand inside a character group is spelled out: the DPL docs describe ranges and negation in groups, not shorthands. `\D`, `\W`, `\S` inside a group → `SPL2006`. | ref |
| `\D`, `\W`, `\S` | `[^0-9]`, `[^a-zA-Z0-9_]`, `[^ \t\r\n]` | | ref |
| `X+`, `X*`, `X{m,n}`, `X{n}`, `X{m,}` | same quantifier | | ref |
| `X?` | `X?` | Optional modifier. | ref |
| `(?:A B)` | `(A B)` | Sequence group. | ref |
| `(?:a\|b)`, `(?:GET\|v\d+)` | `('a' \| 'b')`, `('GET' \| ('v' [0-9]+))` | Alternatives group; the first alternative that matches wins, as in a regex. An alternative with more than one part is wrapped in its own group. | ref |
| `a\|b\|c` (whole pattern, no `^`/`$`) | `('a' \| 'b' \| 'c')` | Same as `(?:a\|b\|c)`. With an anchor → `SPL2006`, because the anchor binds to one alternative only. | ref |
| `(?:…){3}` | the group written out three times | DPL groups take no quantifier. Only a fixed count from 1 to 8; `*`, `+`, `{m,n}` on a group → `SPL2006`. A pattern of more than 2,000 items once every repeat is written out (nested ones count multiplied), or of more than 10,000 characters of DPL → `SPL2006` (ADR-029). | ref |
| `(?i)…` at the start of the pattern | every letter becomes a two-letter group: `error` → `[eE] [rR] [rR] [oO] [rR]`; a range gets both cases: `[a-z]` → `[a-zA-Z]` | DPL literals are case-sensitive and have no flag. Exact, but long. | ref |
| `(?s)…` at the start of the pattern | `.*` becomes `DATA` instead of `LD` | `LD` stops at the end of the line, `DATA` does not. | ref |
| `X(?=Y)`, `X(?!Y)` | `X >>Y`, `X !>>Y` | Look-ahead. More than one matcher in `Y` is put in parentheses. | ref (`>>`), inf (`!>>` has no documented example) |
| `(?<=Y)X`, `(?<!Y)X` | `<<Y X`, `!<<Y X` | Look-behind; DPL looks back at most 64 bytes. | ref (`<<`), inf (`!<<`) |
| `\bword`, `word\b` | `!<<[a-zA-Z0-9_] 'word'`, `'word' !>>[a-zA-Z0-9_]` | A word boundary is "no word character on the other side". Only directly before or after a literal or a class known to be word characters; elsewhere → `SPL2006`. | inf |
| `.*`, `.+`, `.*?`, `.+?` between two fixed parts | `LD` | `LD` runs to the next matcher on the same line, so it is lazy by construction and must be followed by a non-optional matcher. | ref |
| `(?<n>\d+)` | `LONG:n` | Typed as a number. Splunk coerces numeric strings on use, so typed capture is the closer behaviour downstream. | ref, nb (`INT`) |
| `(?<n>-?\d+\.\d+)` | `DOUBLE:n` | | ref, nb |
| `(?<n>\S+)` | `NSPACE:n` | | ref |
| `(?<n>\w+)` | `[a-zA-Z0-9_]+:n` | The notebook uses `WORD:n`; a spelled-out group says exactly what is matched. | ref, nb |
| `(?<n>[^,]+)` | `[^,]+:n` | Exported as string. | ref |
| `(?<n>GET\|POST)` | `('GET' \| 'POST'):n` | An exported alternatives group holds the text of the member that matched. | ref |
| `(?<n>v\d+)`, `(?<ip>\d+\.\d+\.\d+\.\d+)` | `('v' [0-9]+):n`, `([0-9]+ '.' [0-9]+ '.' [0-9]+ '.' [0-9]+):ip` | Any other capture is a sequence group with an export name: "Any matcher output can be exported, including … sequence group and alternatives group. Matched data is exported as STRING." The IP matchers (`IPADDR`, `IPV4`) are not used: they export the `ip` type and normalise the value, a regex capture is plain text. | ref |
| `(?<n>…)?` | `…?:n` | The optional mark goes after the quantifier and before the export name. | ref |
| `(?<n>.*)` followed by a fixed part | `LD:n` | | ref |
| `(?<n>.*)` at the end of the pattern | `DATA:n` | `LD` needs a following matcher, so it cannot be last. Verify (§9 #7). | inf |
| no leading `^` | prefix `DATA?` | Gives search-anywhere behaviour; `parse` otherwise matches from the start. | nb |
| leading `^` | no prefix | | nb |
| no trailing `$` | nothing | `parse` does not need to consume the whole string. | nb |
| trailing `$` | append `EOS` | | inf |

Export names must start with a letter and contain only letters and digits; a name with a dot must be quoted. A capture name with `_` or `.` is emitted quoted (`:'user_name'`), which is `inf` (§9).

The whole pattern is one DQL string in double quotes; switch to `"""…"""` if the DPL contains a double quote.

### 7.2 Not convertible → `SPL2006`

| Construct | Reason |
|---|---|
| Back-references (`\1`, `\k<n>`) | No DPL equivalent. |
| Inline flags other than `(?i)` and `(?s)` at the start (`(?m)`, `(?x)`, `(?i:…)`, a flag in the middle) | No DPL equivalent for multi-line anchors or scoped flags. |
| Repeated group (`(?:ab)+`, `(?:ab){2,5}`), repeated or nested capture (`(?<n>ab)+`) | DPL groups take no quantifier; only a fixed count is written out. |
| A single `.` (any one character), `.` with a count | Only `.*` and `.+` have an equivalent (`LD`, `DATA`). |
| `.*` in the middle of a capture (`(?<n>a.*b)`) | The capture would need a lazy scan inside an exported group. |
| Lazy quantifier other than on `.` | No general lazy mode. |
| `\B`, `\A`, `\z`, `\G`, `\K`; `\b` that is not directly before or after a word | No equivalent. |
| Unicode classes (`\p{L}`), POSIX classes, `\D`/`\W`/`\S` inside a group, atomic/possessive groups, conditionals, recursion | Out of scope. |

### 7.2a `rex max_match`

| SPL | DQL | Notes | Prov |
|---|---|---|---|
| `rex max_match=0 "id=(?<id>\d+)"` | `fieldsAdd id = parseAll(F, "'id=' LONG:id")` | `parseAll` finds every match anywhere in the text and returns an array, so the pattern gets no leading `DATA?`. `SPL3013`: an array, not a multivalue field. | ref |
| `rex max_match=3 …` | `fieldsAdd id = arraySlice(parseAll(F, "…"), from: 0, to: 3)` | The first three matches. | ref |
| more than one named group, or a pattern starting with `^` | — | `SPL2003`: `parseAll` would return an array of records. | — |

### 7.3 Fallback

The stage is emitted as `// not translated: | rex …` with `SPL2006`, and every field the regex would have created is registered as "unresolved" so that later uses raise `SPL4003` instead of silently producing nulls.

## 8. Implementation order

| Wave | Contents | Rationale |
|---|---|---|
| **1 — v0.1** (20) | implicit/explicit `search` (§3 incl. time modifiers), `where`, `eval` (§6), `stats` (§5), `timechart`, `chart`, `top`, `rare`, `table`, `fields`, `rename`, `sort`, `head`, `tail`, `dedup`, `rex` (extract mode, §7.1), `regex`, `fillnull`, `bin`/`bucket`, macro expansion | Covers the commands the comparison doc and notebook exercise; all are T1 or simple T2. |
| **2** | `lookup`, `inputlookup`, `join`, `append`, `union`/`multisearch`, subsearch-as-filter, `eventstats`, `spath`, `mvexpand`, `makemv`, `mvcombine`, `nomv`, `convert`, `replace`, `rex mode=sed`, `makeresults`, `addtotals` (row), `foreach` (literal list), `transaction` (no options), `reverse`, `uniq`, display-only drops | Need the mapping file (lookup paths) and sub-query emission. |
| **3** | `tstats` (data models through the mapping file), `datamodel … search`, `from datamodel:`, `mstats`, array forms of `streamstats`/`accum`/`delta`/`trendline`, `top … by` with per-group limit, `xyseries`/`untable`, `rangemap`, `addinfo`, `timewrap`, regex look-around → DPL, `max_match>1` via `parseAll`, `savedsearch` inlining | Shape-changing or metric-backed; each needs tenant validation. |
| **Never** | `collect`, `outputlookup`, `outputcsv`, `sendemail`, `sendalert`, `delete` (side effects) · `map`, `script` (procedural) · `pivot` (needs the data model definition) · `appendcols`, general `streamstats` (row-order state) · `predict`, `anomalydetection`, `kmeans`, `cluster` (ML; belongs to Davis analyzers, not DQL) · `rest`, `metadata`, `dbinspect`, `eventcount`, `loadjob` (Splunk administration) · `iplocation`, `geostats` (no geo functions in the reference) | Reported with `SPL2002`/`SPL2008`. |

`bin`/`bucket` (Wave 1) for reference:

| SPL | DQL | Notes | Prov |
|---|---|---|---|
| `bin _time span=5m` | `fieldsAdd timestamp = bin(timestamp, 5m)` | `bin()` returns a timestamp. | ref |
| `bin f span=10 as g` | `fieldsAdd g = bin(f, 10)` | | ref |
| `bin _time span=1mon` | `fieldsAdd timestamp = timestamp@M` | | ref |
| `bins=`, `minspan=`, `start=`, `end=`, `span=log2` | — | `SPL2003`. | — |
| `aligntime=` | `bin(timestamp, 5m, at: …)` | `inf`. | ref (param) |

## 9. Open questions to verify on a tenant

Every item below is an `inf` that changes output. Verify with `dtctl verify query` for syntax and a small `data record(…)` fixture for semantics, then update the provenance tag.

| # | Question | Affects |
|---|---|---|
| 1 | Is a backticked alias with parentheses valid: `` summarize `avg(bytes)` = avg(bytes) ``? | global alias rule |
| 2 | In one `fieldsAdd a = …, b = f(a)`, does `b` see the new `a`? | `eval` |
| 3 | Does `summarize takeFirst()/takeLast()` honour a preceding `sort`? | `first`, `last`, `earliest`, `latest` |
| 4 | Does `matchesValue` support a mid-string `*`? (`SKILL.md` says start/end only; `string-matching.md` says anywhere.) | §3.3 |
| 5 | Does `matchesPattern` need to match the whole string, and does a `DATA?` prefix/suffix make it match anywhere? | `regex`, `match()` |
| 6 | Are quoted export names with `_` accepted, and with which quote style inside a DQL string? | §7.1 |
| 7 | `(?<n>.*)` at end of pattern: is `DATA:n` correct, and is `EOS` available in Grail DPL (documented only for the OneAgent subset)? | §7.1 |
| 8 | Is `stddev`/`variance` sample or population? Is `percentile`/`median` exact? | §5 |
| 9 | Does `countDistinctExact` count null as a value? Does `summarize count()` with no `by` return one row with 0 on empty input? | §5 |
| 10 | `from:now()-1d@d+2h`: is arithmetic after `@` accepted in `fetch`? Are `-1q` and `-1y` valid offsets? | §3.2 |
| 11 | `fieldsKeep "host*"`: exact quoting of field patterns, and is column order preserved? | `table`, `fields` |
| 12 | `lookup … prefix:""` and `join … prefix:""`: is an empty prefix allowed? | §4.6 |
| 13 | Does `concat` return null when any argument is null? Does `+` reject strings? | §6.1 |
| 14 | Is `like()` case-sensitive, and how are literal `%`/`_` escaped? | §6.2 |
| 15 | Is `parse(s, "TIMESTAMP('…'):t")` valid in function form and does it return a scalar? | `strptime`, `convert mktime` |
| 16 | Which format letters does `formatTimestamp` accept, and what is its default time zone? | §6.4 |
| 17 | Range of `random()`; hex letter case of `hashMd5` etc. | §6.2 |
| 18 | Are `arrayMovingSum` windows really capped at 60 (notebook claim)? `arrayDelta` vs `arrayDiff` for Splunk `delta`. | §4.3 |
| 19 | `collectArray(record(…))` size limits for the `top` and `eventstats` patterns. | §4.3 |
| 20 | `sum(x, rate: 1s)` equals Splunk `per_second(x)` when the interval is coarsened by `makeTimeseries`. | `timechart` |
| 21 | `dt.system.bucket == "…"` as an in-expression substitute for `bucket:{}`. | §3.2 |
| 22 | `fetch` order with no `sort`: confirm it is unspecified (justifies `SPL5004`). | `head`, `dedup` |
| 23 | `jsonPath(s, "$.a[*].b")` wildcard support and return type. | `spath` |
| 24 | `isFalseOrNull(F in [ … ])` accepted (operator inside a function argument). | subsearch `NOT` |
| 25 | `arraySize` on a scalar: null or error? | `mvcount` |
| 26 | The third argument of `contains`: positional (`SKILL.md`) or named `caseSensitive:` (function reference, notebook)? Not emitted by this spec, but the answer decides whether it can be. | future use |

## 10. Source contradictions found while writing this

| Topic | Source A | Source B | Resolution here |
|---|---|---|---|
| `fieldsRename` syntax | Notebook: `fieldsRename old, alias:new` | Dynatrace docs and local reference: `fieldsRename new = old` | Use `new = old`. |
| `dedup` sort syntax | Local `operators.md`: `sort: {timestamp, desc}` | Dynatrace docs, notebook, ~30 other local examples: `sort:{timestamp desc}` | Use the form without the comma. |
| `matchesValue` wildcards | Local `SKILL.md`: start/end only, split mid-string patterns | Local `string-matching.md`: `*` anywhere | T2 for mid-string until verified (§9 #4). |
| `matchesPattern` argument | Local function reference: DPL pattern | Local `string-matching.md`: describes it as regex and shows `".*--pool.*"` | Treat as DPL; never pass raw regex. |
| `contains` case flag | Local `SKILL.md`: third positional argument | Function reference and notebook: named `caseSensitive:` | Not emitted; `matchesValue` used instead. |
| `IN` in search | Notebook: `in(field, {…})` | Splunk: `IN` is case-insensitive with wildcards; `in()` is exact | Use `matchesValue(F, {…})`. |
| `host=` | Notebook example: `matchesPhrase(host.name, …)` | Same notebook series (S2D-02): that form over-matches; use an exact comparison for like-for-like counts | Use `matchesValue(host.name, …)`. |
| Severity field | Notebook: Splunk `level=ERROR` usually means `status == "ERROR"` (groups several levels) | Literal mapping would be `loglevel` | Not decided here; it is a mapping-file entry. |
