# Testing

## Layers

| Layer | Tool | What it proves | Runs |
|---|---|---|---|
| Unit | Vitest | Each phase and each command module in isolation | every change |
| Conformance | Vitest over `packages/conformance` | SPL in → exact DQL and exact diagnostics out | every change |
| Property | fast-check | The engine invariants hold for arbitrary input | every change |
| Boundary | `scripts/check-boundaries.ts` + `scripts/scan-network.ts` | Dependency direction; no network code in `core`, `web` or its bundles; no outbound connection in the CLI | CI |
| Web unit | Vitest, `apps/web/test` | The web app's pure helpers: line index, view ↔ address, the empty-mapping rule, mapping text edits, the example mapping's results on the five examples, the drop budget | every change |
| End-to-end | Playwright + axe | Every UI state, both themes, accessibility, zero external requests; the built site's `_headers` and `404.html`, lazy views, a start with no connection through the service worker (`apps/web/e2e/launch.spec.ts`) | CI |
| Local server security | Vitest + Playwright | `spl2dql serve`: loopback only, Host check, GET/HEAD only, allow-listed files, headers (`cli.md`) | CI |
| Tenant (by hand) | `dtctl verify query` | Expected DQL is accepted by a real tenant | on demand, by a developer of this project; the product itself never connects (ADR-023) |
| Migration | Vitest, `packages/core/test/migration.test.ts` | `.conf` reading, config import, the XML reader's refusals, both dashboard readers, tokens → variables, layout; all against `examples/splunk-app` | every commit |
| Budgets and hardening | Vitest, `packages/core/test/budgets.test.ts`, `packages/core/test/retest.test.ts`, `packages/core/test/markdown.test.ts`, `packages/cli/test/hardening.test.ts` | ADR-029: every budget, on the security review's own inputs (output, `foreach`, regex items, notes, macro length, Studio positions and layout, the dashboard budget, inputs, base chains); linear readers; Markdown tiles; field names DQL cannot hold; the CLI's output folder, input total, terminal text and report paths | every change |

`pnpm check` runs typecheck, lint, unit, conformance and property tests and must pass before any task
is called done.

## Conformance corpus

```
packages/conformance/cases/<area>.md     many cases per file (ADR-017)
packages/conformance/mappings/<name>.yaml  shared mapping files
```

Each case is a level-2 heading followed by three fenced blocks:

````md
## stats count by one field

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
````

- `diagnostics` lists warnings and errors as `"CODE@stage"`, any order. Info notes are not listed:
  they never change confidence, and listing them made every case noisy.
- `options` may set `timeRange` and `strict`.
- `verified` is `true` only after a real tenant has accepted the DQL (checked by hand with
  `dtctl verify query`, by hand). The runner reports how many
  cases are verified; releases state that number.
- `source` says where the expected behaviour comes from.
- `syntaxOk: false` marks a case whose expected DQL deliberately fails the offline check (none today).

### Rules for expected output

1. An expected `.dql` file is written from the mapping spec or from documentation — **never** by
   running the engine and saving what it printed.
2. When a test fails, the question is which side is wrong. Changing an expected file requires a
   reason that cites a source; "to make the test pass" is not one.
3. Every command module ships with at least: the simplest form, each supported option, each
   unsupported option (expecting its diagnostic), and one case inside a longer pipeline.
4. Every diagnostic code has at least one case that triggers it (enforced by a test).

## Property tests

- `translate` returns for any string (including lone surrogates, control characters, 1 MB of `|`).
- Deterministic and idempotent: translating twice gives equal results.
- The span invariants from `translation-engine.md`.
- Printing any generated DQL AST and re-tokenising it yields balanced brackets and quotes.
- For generated *valid* SPL built from T1 commands: confidence is `high` and the offline syntax check
  is clean.

## Coverage

`core`: 90 % lines and 80 % branches, enforced. `cli`: 80 %. `web`: no percentage target —
measured by the end-to-end state checklist in `ui.md`.

## Markdown tiles

`markdown.test.ts` checks the four output properties of dashboards.md §4 literally, by a plain scan
of every tile the converter writes through every sink that carries Splunk text (panel title,
saved-search name, both descriptions, Studio tab label, `<html>` text, code, headings, list items and
links, `splunk.markdown` in every construct, a manual tile's search): split into lines, skip the
lines of an indented code block the converter wrote, then no `<`, no backtick, no `![`, every raw
`[` is a link `[label](target)` whose target passes the test, no `://` without a backslash before it
and no `www.` outside such a target, no line that opens a fence, no tile over its limit. The
re-tests' inputs are cases; a property test feeds random mixes of addresses, entities, backslashes,
backticks, brackets, angle brackets, payloads and padding around the 8,000 limit to every sink. A
test of the check itself makes sure it flags what earlier rounds let through.

## Performance tests

A test about speed asserts on an output size or a limit where it can. Where a time bound is
unavoidable it is generous (seconds) and the input is one the old code took at least ten times
longer on (or never finished), so it cannot flake on a slow CI machine.

## What tests must not do

- Touch the network in the default suite.
- Depend on the wall clock, the locale or the time zone.
- Assert on diagnostic message wording.
- Snapshot whole `TranslateResult` objects (snapshots hide accidental changes; the corpus files are the
  reviewed record).

## The launch gate

`pnpm gate` (`scripts/launch-gate.ts`) runs everything a commit must pass before it is published
and prints one PASS or FAIL line per check: a clean tree; no credentials in the files or anywhere
in the history (gitleaks); no personal e-mail address in the history; `pnpm audit`; dependency
licences; build; `pnpm check`; coverage thresholds; the browser tests; the built page's security
policy, headers and the absence of outside addresses; the contents of both npm packages
(`scripts/check-packages.ts`); the workflow linters. It changes nothing. CI runs the same checks
as separate jobs; the gate is the one command a maintainer reads before a release.
