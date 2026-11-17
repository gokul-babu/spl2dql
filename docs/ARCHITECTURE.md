# Architecture

System-level view: what the pieces are, what each may depend on, and how a query flows through them.
Engine internals are in `docs/spec/translation-engine.md`. Comments and specifications cite
decisions by number (ADR-nnn); the decision record itself is kept by the maintainer and is not part
of this repository.

## What the product is

A migration tool from Splunk to Dynatrace — SPL searches to DQL queries, Splunk dashboards to
Dynatrace dashboards — with three faces. None of them opens a network connection, and none will
(ADR-023).

| Face | Who uses it | Network |
|---|---|---|
| Web app (static, installable) | Someone converting queries one at a time and reviewing the result | None |
| CLI | Someone converting a whole Splunk app — saved searches, dashboards, configuration — in a migration | None |
| `spl2dql serve` | Someone who installed the CLI and wants the web app locally | Listens on 127.0.0.1 only; no outbound connection |

## Repository layout

```
.
├── docs/                         architecture, specifications, release steps (this folder)
├── third_party/                  vendored Apache-2.0 reference data, with licences
├── packages/
│   ├── core/                     @spl2dql/core — the translation engine
│   │   └── src/
│   │       ├── spl/              stage splitter, scanner, search/eval parsers, macros, time
│   │       ├── commands/         one file per command family, plus the registry
│   │       ├── lower/            lowering context, expressions, aggregations, regex, pipeline
│   │       ├── dql/              DQL AST, printer, parser, catalogue, offline syntax check
│   │       ├── mapping/          mapping-file types, validation, resolution
│   │       ├── io/               readers for Splunk's files: .conf syntax, saved searches, CSV,
│   │       │                     and macros/props/eventtypes/tags → mapping sections (ADR-024)
│   │       ├── dashboard/        XML reader, Simple XML and Dashboard Studio readers, the neutral
│   │       │                     model, tokens → variables, the Dynatrace document writer (ADR-026)
│   │       ├── diagnostics/      code registry and messages
│   │       └── index.ts          public API: translate(), convertDashboard(), importSplunkConfig() …
│   ├── conformance/              cases/<area>.md and mappings/*.yaml — data plus a loader
│   └── cli/                      spl2dql — commands, report writers, local web app server
├── apps/
│   └── web/                      React UI
└── examples/
    └── splunk-app/               a made-up Splunk app: fixture for tests, sample in the web app
```

## Dependency rules

```
apps/web ──────────► packages/core ◄────────── packages/cli
packages/conformance is read by tests in core and cli; it imports nothing.
```

1. `core` has **zero runtime dependencies** and uses no Node or DOM API. It must run unchanged in a
   browser, a worker and Node.
2. `web` depends on `core` only and contains no network code. Its one import from outside its own
   folder is the sample app's files, as text.
3. The CLI opens no outbound connection; `spl2dql serve` only listens on loopback.
4. Nothing depends on `cli`.

These are checked in CI by `scripts/check-boundaries.ts` and `scripts/scan-network.ts` (ADR-006).

## Data flow

### Offline translation (web and CLI)

```
SPL text ─► core.translate(spl, { mapping, timeRange })
              lex → split stages → parse per command → expand macros → resolve names
              → lower to IR → normalise → emit DQL AST → print → offline syntax check → score
          ─► TranslateResult { dql, confidence, score, diagnostics[], stages[] }
```

In the web app this runs in a Web Worker so typing never blocks; results are debounced by 150 ms.

### A Splunk app (CLI `batch`, or files dropped on the web app)

```
files ─► sort by kind
           macros/props/transforms/eventtypes/tags.conf ─► core.importSplunkConfig ─► mapping sections
                                                                  laid under the mapping file ──┐
           savedsearches.conf, .spl, .csv ─► searches (with saved time range) ─► core.translate ◄┤
           dashboards (.xml, .json) ─► core.readDashboard ─► DashboardModel                      │
                                         ─► core.convertDashboard (translate per panel, ◄────────┘
                                            tokens → variables) ─► Dynatrace dashboard JSON
       ─► .dql files, dashboards/*.json, report.html / report.json
```

## Technology

Versions resolved on 2026-11-14 (pnpm refuses versions younger than seven days, so some are one
release behind the newest). The lockfile is the source of truth.

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 7.0 | native compiler; emits ESM + declarations (ADR-018) |
| Runtime | Node 26 (floor 24) | runs `.ts` sources directly in development (`--conditions=source`) |
| Package manager | pnpm 12 | `minimumReleaseAge` 7 days, no install scripts |
| Lint + format | Biome 2.6 | |
| Tests | Vitest 5.1, fast-check 4.10 | unit, conformance, property, integration |
| Browser tests | Playwright 1.65, @axe-core/playwright 4.14 | |
| Web build | Vite 8.3, @vitejs/plugin-react 6.2 | strict CSP injected at build time |
| UI | React 19.3, CodeMirror 6 (used directly), Tailwind CSS 4.3, lucide-react | native dialog/popover/select instead of a component library (ADR-019) |
| State | Zustand 5 | |
| Fonts | Atkinson Hyperlegible Next / Mono (variable, bundled) | OFL-1.1 |
| Compression | fflate | share links and batch downloads |
| CLI | commander 15, yaml 2.9 | |
| Local web app server | `node:http` | static files only, no framework (ADR-022) |

## Cross-cutting rules

- **Errors.** `core` returns diagnostics and never throws on user input. The CLI maps its own errors
  to exit codes. No `catch` block swallows an error silently.
- **Secrets.** None: nothing in this release reads a credential.
- **Logging.** `core` does not log. The CLI writes results to stdout and everything else to stderr.
- **Performance budgets.** A 10 KB query translates in under 5 ms on a laptop. `core` is under 60 KB
  minified and gzipped. The web app's first load is under 350 KB gzipped including fonts.
- **Limits.** Input over 1 MB, subsearch nesting over 16, or expression depth over 256 produce a
  diagnostic, not a crash. A dashboard file over 10 MB, XML nested over 100 deep or with over
  200,000 elements is refused with a message.
- **Accessibility.** WCAG 2.2 AA; status is never conveyed by colour alone.
