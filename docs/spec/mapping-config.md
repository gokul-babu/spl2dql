# Mapping file

Environment-specific knowledge the translator cannot derive from a query: where a Splunk index's data
lives in Grail, what a field is called there, what a macro expands to. The translator never guesses
these (ADR-010). Without a mapping it still translates, using the built-in defaults below, and reports
every unresolved name.

Format: YAML or JSON. `core` receives the already-parsed object and validates it by hand
(`parseMappingConfig`); YAML parsing happens in the CLI and the web app.

## Schema (version 1)

```yaml
version: 1

defaults:
  dataObject: logs              # fetch target when an index has no entry: logs | events | bizevents | spans
  timeframe: null               # e.g. "-24h"; null leaves the timeframe to the Dynatrace UI
  timezone: UTC                 # IANA zone used to convert absolute SPL times such as "10/27/2026:00:00:00"

indexes:                        # Splunk index name (wildcards allowed) → where the data is in Grail
  web:
    dataObject: logs
    buckets: [web_logs]         # optional; emitted as `bucket:{…}` on fetch
    filter: 'dt.security_context == "web"'    # optional DQL condition, emitted verbatim after fetch
  "sec_*":
    dataObject: events

sourcetypes:                    # Splunk sourcetype → a DQL condition and optional extractions
  access_combined:
    filter: 'log.source == "/var/log/nginx/access.log"'
    extractions: [status, bytes, clientip]    # names from `extractions` below, applied when referenced

fields:                         # Splunk field name → Grail field name
  level: loglevel
  src_ip: client.ip

extractions:                    # search-time fields that must be parsed at query time in Grail
  status:
    from: content
    dpl: "DATA? 'status=' INT:status"
  response_time:
    from: content
    dpl: "DATA? 'response_time=' DOUBLE:response_time"

macros:                         # savedsearch macros, from macros.conf
  errors_only:
    definition: 'level=ERROR OR level=FATAL'
  recent(1):
    args: [span]
    definition: 'earliest=-$span$'

fieldTypes:                     # Grail field name → type, so comparisons and sorts are emitted correctly
  status: number                # number | string | time | duration | boolean | ip
  client.ip: ip

lookups:                        # lookup table name → Grail lookup file
  http_status:
    path: /lookups/http_status
    key: code
    columns: [code, description, class]     # lets `lookup` without OUTPUT emit an explicit fields list

eventtypes:                     # Splunk eventtype / tag → a DQL condition
  failed_login: 'event.type == "auth" and outcome == "failure"'
tags:
  authentication: 'event.category == "authentication"'

metrics:                        # Splunk metric name → Grail metric key (for mstats)
  cpu.pct: dt.host.cpu.usage

datamodels:                     # Splunk data model, or "Model.Dataset" → where its data is in Grail
  Authentication:
    dataObject: logs            # default: defaults.dataObject
    buckets: [auth_logs]        # optional
    filter: 'event.category == "authentication"'    # optional DQL condition, emitted verbatim after fetch
    fields:                     # data-model field (without the dataset prefix) → Grail field
      user: user.name
      src: client.ip
      action: event.outcome
  Endpoint.Processes:           # a dataset of a model that has several
    filter: 'event.type == "process"'
    fields:
      process_name: process.executable.name
      dest: host.name
```

### Data models (ADR-025)

A Splunk data model is a named, normalised view over events; Grail has no such layer. The mapping
says where that view's data is and what its fields are called.

- **Lookup.** `datamodel=Endpoint.Processes` uses the entry `Endpoint.Processes`; without one, the
  entry `Endpoint`, with `SPL4008` saying that the dataset's own constraint is not applied.
  `Model.Model` (the root dataset named like the model, e.g. `Web.Web`) is the same as `Model`.
  `where nodename=Model.Dataset` in `tstats` selects the dataset the same way.
- **No entry.** The search is still translated: `fetch <defaults.dataObject>`, all records read,
  field names kept without their prefix, and `SPL4008` on the model plus `SPL4003` for each field
  (subject `datamodel:<entry>:<field>`, so `mapping init` lists them under the model).
- **Field names.** In a data-model search every field is written `<dataset>.<field>`
  (`Authentication.user`, `All_Traffic.dest_port`). The prefix — everything up to the last dot — is
  dropped, then the field is looked up in the entry's `fields`, then in the top-level `fields`, then
  the built-in defaults. This holds for the rest of the pipeline, so `Authentication.user` after the
  `tstats` still resolves. A full dotted name listed in the top-level `fields` wins and is not split.
- **Prefix removal in SPL** (`rename Authentication.* as *`, `` `drop_dm_object_name(Authentication)` ``)
  has nothing left to do and is dropped with `SPL5007`. `drop_dm_object_name(1)` is built in (Splunk's
  Common Information Model add-on defines it to remove the dataset prefix); a definition in `macros`
  wins.
- **Extractions are not applied** in a data-model search: its fields are already normalised.

## Built-in defaults

Applied when the mapping has no entry. User entries always win.

| Splunk | Grail | Provenance |
|---|---|---|
| `_raw` | `content` | S2D notebook; standard Grail log field |
| `_time` | `timestamp` | standard Grail log field |
| `host` | `host.name` | S2D notebook |
| `source` | `log.source` | S2D notebook |
| `index` used inside an expression | `dt.system.bucket` | inferred — open question 21 in the mapping spec |
| `index` (unmapped) | `fetch logs`, predicate dropped, `SPL4001` | ADR-010 |
| `sourcetype` (unmapped) | predicate dropped, `SPL4002` | ADR-010 |

Applying any built-in default reports `SPL5002` once per query. The diagnostic catalogue is in
`spl-dql-mapping.md` §2: `SPL4001` index, `SPL4002` sourcetype, `SPL4003` field that probably relies on
search-time extraction, `SPL4004` macro, `SPL4005` lookup, `SPL4006` eventtype/tag, `SPL4007` metric,
`SPL4008` data model, `SPL4009` dashboard token. Each default above must be confirmed against a
tenant before 1.0.

With `strict: true` (CLI `--strict`) every `SPL4xxx` is raised from a warning to an error, so a query
that depends on a missing mapping can never come out above "Incomplete".

## Resolution rules

1. Exact name match beats wildcard match; among wildcards the longest pattern wins.
2. `indexes.*.filter` and `sourcetypes.*.filter` are user-supplied DQL. They are parsed with the
   offline syntax check when the mapping is loaded; a failure is a mapping issue, reported before any
   translation, not a per-query diagnostic.
3. An extraction is inserted once, immediately before the first stage that references the field
   (after the `fetch` when that stage is the first one), and only if no earlier stage already created
   a field of that name. It is emitted as `parse <from>, "<dpl>", preserveFieldsOnFailure:true`: like a
   Splunk search-time extraction it only adds the field where the pattern matches, so a record of
   another shape keeps the value it already has instead of getting null. Two fields that share one
   pattern get one `parse`.
4. Macros expand before parsing the stage that contains them; expansion depth is limited to 10, and a
   cycle, an over-deep expansion or an argument-count mismatch is `SPL1005`. A missing definition is
   `SPL4004`.
5. A lookup without an entry translates to a `lookup` against a placeholder path
   `/lookups/<name>` with `SPL4005`, telling the user to upload the table and map it.

## Validation

`parseMappingConfig` returns `{ ok: false, issues }` with a JSON-pointer path and a plain-language
message for each problem: unknown top-level key, wrong type, unsupported `version`, DQL filter that
fails the syntax check, macro argument count mismatch. Unknown keys are errors, not ignored, so typos
are caught.

## From Splunk configuration files (ADR-024)

`importSplunkConfig(files)` in `core` reads Splunk `.conf` files and returns mapping sections as
plain data. The CLI (`batch`, `dashboard`, `mapping init`) and the web app call it for every such
file among their inputs. An entry already in the mapping file always wins. Nothing is guessed: a
definition that cannot be carried over is returned in `skipped` with the reason, and `mapping init`
prints those as comments. A definition the import cannot process at all (a regular expression the
converter chokes on, say) is skipped the same way — "This definition could not be processed and was
skipped." — and the rest of the import goes on (ADR-029).

What is imported is held to the mapping file's own limits, so `mapping init` can always read back
what it wrote: at most 10,000 entries per section, a definition or a pattern of at most 10,000
characters (a regex whose DPL would be longer is refused while it is converted), an eventtype or tag
condition that passes the DQL condition check. All sections together hold at most 5,000,000
characters of definitions; what does not fit is skipped, with one note for the budget and one per
full section. A tag's combined condition is measured before it is built. Merged under a mapping
file's own entries, the imported ones fill each section only up to 10,000 entries in total; the
mapping file's own entries always stay.

| File | Reads | Becomes | Left out, with a reason |
|---|---|---|---|
| `macros.conf` | `[name]` / `[name(2)]`, `definition`, `args` | `macros` | `iseval = 1` (Splunk computes the text at run time); a name/`args` count mismatch; a missing definition |
| `props.conf` | `EXTRACT-<class> = <regex> [in <field>]` | `extractions`, one entry per named group, `from: content` or the named field | a regex outside §7 of the mapping spec; a pattern with no named group; a second, different definition of the same field (the first is kept) |
| `props.conf` + `transforms.conf` | `REPORT-<class> = <transform>, …` with `REGEX` and optional `FORMAT = field::$1 …`, `SOURCE_KEY` | `extractions` (numbered groups are named from `FORMAT`) | delimiter-based transforms (`DELIMS`); `FORMAT` that takes the field name from the event (`$1::$2`); a transform not in the given file |
| `eventtypes.conf` | `[name]`, `search` | `eventtypes`: the search translated to one DQL condition (`translateCondition`) | a search with a pipe, a subsearch or an untranslatable part; `disabled = 1` is ignored silently |
| `tags.conf` | `[eventtype=x]` and `[field=value]` with `tag = enabled` | `tags`: the conditions of everything carrying the tag, joined with `or` | a tag with a member that could not be converted (the whole tag, so it never matches too little) |

`.conf` syntax: `[stanza]` headers, `key = value`, a trailing backslash continues the value on the
next line, `#` starts a comment line, a key written twice keeps the last value, keys before the
first header belong to `default`. The key runs to the first `=` and is trimmed; the value is the rest
of the line, without the one blank after `=` and trimmed at the end. The reader finds the `=` with a
plain search, so a long line costs time in proportion to its length (ADR-029). Files are merged in
the order given, stanza key by stanza key, so `local/` (which sorts after `default/`) overrides it,
as in Splunk.

`translateCondition(search)` returns a condition only when the search is a pure filter: one stage,
`fetch` plus `filter`/`filterOut`. A mapped index contributes `in(dt.system.bucket, {…})`.

## Tooling that produces a mapping

- `spl2dql mapping init <inputs…>` reads searches, dashboards and Splunk configuration files and
  writes a skeleton: every index, sourcetype, field, macro, lookup, eventtype and data model (with
  the fields read from it) that is still unresolved, plus everything imported from the configuration
  files. Works offline.
- The Mapping view of the web app does the same for dropped files.
