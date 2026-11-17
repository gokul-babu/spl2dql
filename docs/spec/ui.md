# Web UI

## Who it is for and what it must do

An engineer moving saved searches, dashboards and alerts from Splunk to Dynatrace. They know SPL well
and DQL less well. They are responsible if a migrated alert stops firing, so the job of the screen is
not "show a result" but **show what can be trusted and what needs a second look**.

The app opens directly on the working tool. There is no landing page, hero or marketing copy —
also on the hosted site (ADR-027). What a first visit needs to know fits in the header: the name,
one sentence under it ("Translates Splunk searches to Dynatrace DQL, dashboards included."), "Runs in
your browser", and an **About** dialog (ADR-030).

## Design direction

### The one distinctive element: the seam

SPL and DQL are both pipelines. The screen is two panes — SPL on the left, DQL on the right — joined
by a narrow vertical **seam**. For every SPL pipeline stage the seam carries one marker and a ribbon
that connects that stage's lines on the left to the DQL lines it produced on the right, in the manner
of a visual diff tool. The marker's shape and colour give the stage's status. Pointing at or moving
the caret into a stage lights up its counterpart and its notes.

That traceability is the whole visual idea. Everything else on the screen stays quiet so the seam
reads clearly. Panes are flat, full-height regions, not cards; there are no shadows except on
popovers, no gradients, no decorative icons.

### Colour

Colour means status and nothing else. The four status hues are chosen to stay distinguishable under
the common colour-vision deficiencies, and each is always paired with a shape and a word.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--canvas` | `#EEF1F0` | `#1A2227` | page background, the seam |
| `--surface` | `#FBFCFB` | `#222C32` | editor panes, panels |
| `--ink` | `#17232B` | `#E6ECEA` | text |
| `--ink-muted` | `#51616B` | `#9DAAB0` | secondary text, line numbers |
| `--line` | `#CBD3D1` | `#37444B` | dividers, control borders |
| `--exact` | `#0B6E78` | `#4FB8C2` | exact stages, primary action, focus ring |
| `--check` | `#9A5B00` | `#E0A64A` | stages to review |
| `--blocked` | `#A8214F` | `#F07A9E` | untranslated stages, errors |
| `--note` | `#3D5878` | `#8FB0D6` | informational notes |

Both themes ship; the default follows the system setting. Contrast of every text/background pair is
checked with axe in CI — if a pair fails AA, adjust lightness only, keeping the hue.

Neither Splunk's nor Dynatrace's brand colours are used: the project is not affiliated with either.

### Type

| Role | Family | Why |
|---|---|---|
| Interface | Atkinson Hyperlegible Next (variable) | Designed so similar characters cannot be confused |
| Code | Atkinson Hyperlegible Mono (variable) | Same property where it matters most: `l`/`1`/`I`, `0`/`O` in queries |

Sizes: 13 / 14 / 15 (body) / 18 / 24 px. Weights 400 and 650 only. Code is 14 px with 1.55 line height.
Sentence case everywhere — no all-caps labels, no letter-spaced eyebrows. Fonts are bundled; nothing
loads from a font CDN.

### Shape and spacing

4 px spacing unit. Controls have a 6 px radius; panes and the seam have none. Dividers are 1 px
`--line`. Minimum hit target 32 × 32 px (44 on touch).

### Motion

Only in response to an action: ribbons re-flow over 120 ms when the translation changes; "Copy DQL"
flips to "Copied" for 1.5 s. Nothing animates on load. `prefers-reduced-motion` removes all of it.

## Layout

### Translate (the default view), ≥ 900 px

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ spl2dql            Translate  Batch  Dashboards …   ● Runs in your browser ⓘ ⚙ │
│ Translates Splunk searches to Dynatrace DQL, dashboards included.            │
├──────────────────────────────────┬──────┬────────────────────────────────────┤
│ Splunk SPL               Example ▾│      │ Dynatrace DQL           Copy DQL   │
│                                   │      │                                    │
│ 1  index=web status>=500          │ ●━━━━│ 1  fetch logs, from:-24h           │
│                                   │  ╲━━━│ 2  | filter status >= 500          │
│ 2  | stats count by host          │ ●━━━━│ 3  | summarize count = count(),    │
│                                   │      │ 4      by:{host.name}              │
│ 3  | sort -count                  │ ●━━━━│ 5  | sort count desc               │
│ 4  | transaction session          │ ■    │ 6  // not translated: transaction… │
│                                   │      │                                    │
├──────────────────────────────────┴──────┴────────────────────────────────────┤
│ ■ 1 of 4 stages not translated   ■ Incomplete   Syntax check (offline) passed│
│ ▾ 2 notes                                  ● Exact  ▲ Check  ■ Not translated│
│ ▲ 1 name needs a mapping.   Add them to the mapping   Show the names         │
│ ■ Stage 4  transaction has no DQL equivalent.                     SPL2002    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Left pane: editable. Right pane: read-only, selectable, with its own line numbers.
- The seam is 56 px wide. Markers: ● exact, ▲ check, ■ untranslated. A legend with the three
  marks and their words sits at the right of the notes header wherever there are notes.
- The status line leads with what blocks the query: "2 of 4 stages not translated" (or "None of
  this search could be translated."), then the confidence word, then "Syntax check (offline)" in
  smaller, muted type.
- Notes of a stage whose status is Not translated carry ■ whatever their severity and come first.
- The copy button says **Copy incomplete DQL** and is not primary-styled when the confidence is
  Incomplete; it is disabled when the confidence is Not translated (nothing to copy).
- The notes panel is resizable and collapses to a one-line summary. Selecting a note scrolls both
  panes to its stage.
- Content is left-aligned throughout.

### Below 900 px

Panes stack: SPL, then a horizontal strip of stage markers (the seam turned on its side), then DQL,
then notes. Selecting a marker scrolls to that stage's DQL.

The header becomes three rows: the name with the three controls, the sentence, then the views on
one row (13 px links) that scrolls sideways when it does not fit; each link is a real link, so
keyboard focus scrolls it into view. In the empty state the examples come first, then the SPL
editor; the DQL pane and the marker strip appear once there is a search.

### Other views

| View | Purpose | Main elements |
|---|---|---|
| Batch | Convert many searches | The shared drop zone; a table (name with its saved time range and schedule, confidence, note count) filterable by confidence; a row opens in Translate; "Download results" (zip of `.dql` plus a report) |
| Dashboards | Convert Splunk dashboards | The shared drop zone; a list of converted dashboards; for the selected one the **layout preview**, the selected tile's Splunk search beside its DQL with its notes, the variables, what was left out; "Download dashboard", "Download all" |
| Mapping | Edit the mapping file | The raw YAML; "Import", "Download mapping"; unresolved names of the current search (data models included) listed with "Add"; the shared drop zone for Splunk configuration files |
| Reference | What is supported | A table generated from `listCommands()`: command, tier, notes; every diagnostic code with its explanation |
| Settings (dialog) | Theme, editor font size; a line saying nothing leaves the device | No account, no sign-in |
| About (dialog) | What the tool is, version, links to the source (GitHub) and the CLI (npm), the licence and third-party notices, the privacy note and the disclaimer | Texts below, verbatim |

### The shared drop zone

One component on Batch, Dashboards and Mapping. It takes files, a folder ("Choose a folder", or a
dropped folder) and — while its view is empty — "Load the sample app". Whatever the mix, everything
is done: definitions from Splunk configuration files are added to the mapping text (an entry the
mapping has is kept, and so are its comments), searches are translated, dashboards converted. Below
it one summary says what else was in the files, with a button to the view that shows it, and lists
the definitions that could not be carried over with their reasons.

### Dashboards: the layout preview

The second distinctive element, and the same idea as the seam: show what will be trusted. The
preview *is* the converted layout — a 24-column grid with every tile at its place — not a list.
Each tile is a button with its status mark, its title and, when it is taller than one row, the
status word and the Dynatrace visualization. A tile of four rows or more also carries a quiet figure
of what it will draw (a line chart, bars, a table, a number; a wrench for manual work) in `--line`,
so the preview reads as a dashboard and not as a list of boxes. The figure repeats the visualization
word and is hidden from assistive technology. Selecting a tile shows its Splunk search beside its
DQL ("DQL so far" for a panel that needs manual work), its notes, "Copy DQL" and "Open in
Translate". A new dashboard opens on the first tile that needs manual work.

| Status | Mark | Word |
|---|---|---|
| live tile, no notes | ● `--exact` | Converted |
| live tile with notes | ▲ `--check` | Converted, check |
| text tile holding the Splunk search | ■ `--blocked` | Needs manual work |
| text panel | ≡ muted | Text |

Below 900 px the dashboard list becomes a horizontal strip above the preview; the grid keeps its 24
columns and truncates titles.

## Components

| Component | Notes |
|---|---|
| `SplEditor` | CodeMirror 6; highlighting from `core`'s lexer (so it can never disagree with the parser); squiggles from diagnostics; stage gutter |
| `DqlViewer` | CodeMirror 6 read-only; `StreamLanguage` tokenizer for DQL; line highlights for the active stage |
| `Seam` | SVG between the editors; reads line geometry from both editor views; redraws on scroll, resize and result change |
| `NotesPanel` | List of diagnostics grouped by stage; each has severity mark, message, hint, optional action |
| `ConfidenceBadge` | Word plus mark: "Exact", "Needs review", "Incomplete", "Not translated" |
| `ModeIndicator` | "Runs in your browser" ("Offline" read as a lost connection on a public site); opens a popover saying that nothing leaves the device |
| `AboutDialog` | Opened from the ⓘ button in the header; see Words → About |
| `Legend` | ● Exact ▲ Check ■ Not translated, beside the notes count |
| `MappingLine` | One line above the notes about the mapping: example mapping in use, a mapping with a problem, or names that need a mapping |
| `BatchTable`, `MappingForm`, `ReferenceTable` | as described above |

Build order within the milestone: editors with linked highlighting and gutter markers first; the
ribbons second. The app is useful without ribbons; it is not shippable without linked highlighting.

## States

| State | What the user sees |
|---|---|
| Empty | Left pane shows a placeholder: "Paste a Splunk search, or pick an example." The right pane offers the five examples as buttons ("Start from an example"), the two file views ("Translate saved searches", "Convert dashboards"), and one line saying that everything runs in this browser. It disappears as soon as there is a search. |
| Translating | No spinner — translation is faster than a frame. Output is replaced when ready. |
| Parse problem | The DQL for everything parseable is still shown. The broken span is underlined; the note says what was expected. |
| Nothing translatable | Right pane: "None of this search could be translated." with a link to Reference. |
| Mapping missing | The person's own search and an empty mapping: one line above the notes, "3 names need a mapping.", with "Add them to the mapping" (adds an entry per name, each marked with a comment, and opens Mapping at the first) and "Show the names" / "Hide the names" (the individual notes, hidden until then). The confidence word does not change. With a mapping of their own, each name is its own note with "Add mapping", which adds that entry and opens Mapping at it. |
| Example mapping in use | An unmodified built-in example (or a sample-app search) and an empty mapping: "Using the example mapping. Your own searches need yours." with "Open Mapping"; Mapping shows "Example mapping in use" and the example text. "Add mapping" is not offered. |
| Mapping has a problem | "The mapping file has a problem, so it was not used." with "Open Mapping". |
| Translator stopped | Status line: "This search took too long to translate and was stopped." (120 s) or "The translator stopped unexpectedly. Change the search to try again." (the worker failed; answered at once, not after the limit). |
| DQL too long | Over 500,000 characters (half the engine's 1,000,000 cap: about 900,000 measured a 330 ms stall and 56,000 DOM nodes) the DQL pane shows "This DQL is N characters long, too long to show here. Copy DQL still copies all of it." Over 300,000 characters editors show text without colours. |
| Files over budget | "These files add up to more than 100 MB. Choose fewer files at once." — nothing is read. |
| Long lists | A list whose length comes from a file or a search is shown up to a limit, followed by "Showing the first 2,000 of 60,000 searches. All of them are in the download." (the second sentence only where there is a download). Counts, downloads and copying always use the whole list. Limits: Batch table 2,000 rows; notes of one translation 500; the marker strip 500 stages; converted dashboards 500; tiles of one dashboard 500; variables, notes of a tile or dashboard, names not translated, missing names, data models, mapping problems, definitions not carried over and file problems 200 each. |
| Results over budget | One drop keeps at most 50,000,000 characters of results. Translation stops before the search or dashboard that would go over; the summary says "These files produce more than 50 MB of DQL. The rest was not translated; choose fewer files at once." and, under "*N* searches and *M* dashboards were not translated", names each one. What was translated is shown and downloads as usual. |
| View loading | A view's code loads on demand. The area stays empty; after 400 ms it says "Loading…". A view that cannot load: "This page could not be loaded. Reload to try again." |
| No JavaScript | The static shell (name, sentence, views) and "spl2dql needs JavaScript: the translation runs in this page, in your browser. Turn JavaScript on for this site to use it." |
| Storage unavailable | The app works; preferences are not remembered. No error is shown. |

## Words

Vocabulary is fixed and used identically in UI, CLI and reports:

| Concept | Word |
|---|---|
| stage statuses | Exact · Check · Not translated |
| confidence | Exact · Needs review · Incomplete · Not translated |
| offline DQL check | Syntax check (offline) |
| diagnostics | notes |
| dashboard panels | Converted · Converted, check · Needs manual work · Text |
| dashboard variables | Filled by a query · Fixed list · Free text |

Buttons say what they do: "Copy DQL", "Copy incomplete DQL" (when the confidence is Incomplete),
"Download results", "Add mapping", "Add them to the mapping", "Open Mapping". Messages state what
happened and what to do, without apology or blame. No exclamation marks.

Fixed strings added in M15 (ADR-030):

| Where | Text |
|---|---|
| sentence under the name, page description | Translates Splunk searches to Dynatrace DQL, dashboards included. |
| mode indicator | Runs in your browser |
| header buttons (accessible names) | About · Settings |
| skip link | Skip to content |
| time range field (accessible name) | From (start of the time range) |
| status line | 2 of 4 stages not translated |
| legend | Exact · Check · Not translated |
| example mapping | Using the example mapping. Your own searches need yours. · Example mapping in use · Show the example mapping · Converted with the example mapping. Your own files need yours. |
| missing names | 1 name needs a mapping. · 3 names need a mapping. · Add them to the mapping · Show the names · Hide the names |
| comment on an added entry | Added by spl2dql: replace with where this lives in Grail. |
| page titles | Translate – spl2dql (and Batch, Dashboards, Mapping, Reference); Page not found – spl2dql |
| 404 page | Page not found · There is nothing at this address. · Open the translator |
| limits (ADR-029) | These files add up to more than 100 MB. Choose fewer files at once. · These files produce more than 50 MB of DQL. The rest was not translated; choose fewer files at once. · *N* searches and *M* dashboards were not translated (singular: 1 search was not translated) · *name* (dashboard) · These files took too long to read and were stopped. Choose fewer files at once. · The searches took too long to translate and were stopped. Choose fewer files at once. · *name* took too long to convert and was stopped. · *name* stopped the translator and was not converted. · This DQL is *N* characters long, too long to show here. Copy DQL still copies all of it. |
| shortened lists | Showing the first *limit* of *total* *things*. — with "All of them are in the download." after it for searches, dashboards, tiles and variables. *things*: searches, notes, stages, dashboards, tiles, variables, names, data models, problems, definitions |
| a view that cannot load | This page could not be loaded. Reload to try again. |
| mapping file with a problem | The mapping file has a problem, so it was not used. |
| page title and social title | spl2dql: Splunk searches to Dynatrace DQL |
| About links | Source code on GitHub · The command-line tool on npm · Third-party notices · Licensed under Apache-2.0 · Version X.Y.Z (the release version, from `packages/cli/package.json`) |

About dialog, verbatim (ADR-031):

- Privacy: "No account, no analytics, no cookies. Your searches, files and mapping stay in this
  browser; settings are kept in its local storage. The company that hosts this page sees the usual request logs when the page loads, and your browser may tell it when a connection to the page fails. Nothing you type or drop here is ever sent."
- Disclaimer: "spl2dql is an independent open-source project. It is not affiliated with, endorsed by
  or supported by Splunk Inc., Cisco or Dynatrace. Splunk, SPL, Dynatrace and DQL are trademarks of
  their respective owners and are used only to describe what this tool works with. Provided without
  warranty; check every translated query before relying on it."

## Behaviour

- Translation runs in a Web Worker, 150 ms after the last keystroke. The Translate view has a worker
  of its own; dropped files use a second one, so typing never waits behind a large drop.
- The view is in the URL fragment, so Back, Forward and reload work and the page title names the
  view: no fragment is Translate; `#/batch`, `#/dashboards`, `#/mapping`, `#/reference`; anything
  else opens Translate. A fragment, not a path, because the site is static files (a path would need
  every address rewritten to `index.html`, and `404.html` would answer instead).
- A shared search is kept in the URL fragment as `#q=<deflate, base64url>` so a translation can be
  shared as a link without a server; links made before M15 open unchanged. A share link is applied
  when it arrives (on load, or pasted into an open tab); coming Back to it keeps the edits made
  since. The mapping is never placed in the URL.
- **Example mapping** (ADR-030): the sample app's `spl2dql.mapping.yaml` plus the entries the five
  examples need (`apps/web/src/lib/example-mapping.ts`), plus what the sample app's `.conf` files
  define. It is used only when both hold: the person's mapping text is empty (only comments,
  `version` and empty sections — anything else counts as theirs) and the search is exactly a
  built-in example or a search of the sample app as loaded. Loading the sample app while the mapping
  is empty converts it with the example mapping and leaves the person's mapping untouched. With it,
  the five examples come out Exact, Needs review, Needs review, Needs review, Incomplete.
- Worker limits (ADR-029): 120 s per request, 20 s per dashboard (one dashboard per request). A
  worker that errors rejects every waiting request at once. A drop over 100 MB in total, over 2,000
  files or with a file over 10 MB is refused before anything is read; reading and parsing files run
  in the worker.
- Trusted Types: the one policy (`spl2dql`, the only name the policy allows) accepts exactly two
  addresses, the translation worker under `assets/` and `sw.js`, as http(s) URLs on the page's own
  origin. A same-origin `blob:` or `data:` address, any other path and any other origin is refused.
- One drop keeps at most 50,000,000 characters of results across its searches and dashboards
  (ADR-029, second round). Results are trimmed in the worker to what the views show or download:
  a search keeps its DQL, confidence and notes (charged: DQL plus the text of its notes); a
  dashboard keeps its Dynatrace document, each tile's DQL, Splunk search and notes, and its
  variables without their translation details (charged: the whole kept conversion). The SPL text
  of each search is kept for "Open" and the download and is bounded by the 100 MB input budget.
- Batch, Dashboards, Mapping and Reference load on demand; pointing at or focusing a view's link
  starts loading it. The first paint is a static shell in `index.html` (name, sentence, views),
  styled by the app's stylesheet only.
- Preferences and the current mapping persist in `localStorage`; every read and write is wrapped so a
  blocked or full store degrades silently.
- Keyboard: `Mod+Shift+C` copy DQL · `F8` / `Shift+F8` next / previous note · `Mod+K` example menu ·
  `Alt+↑/↓` move between stages. All shown in a shortcuts dialog (`?`).
- There are no online controls, and there will be none (ADR-023).
- Dashboard conversion and the reading of Splunk configuration files run in the Web Worker, like
  translation.

## Accessibility

- WCAG 2.2 AA. Full keyboard operation, visible `--exact` focus ring (2 px, 2 px offset).
- The seam is presentational (`aria-hidden`); the same information is in the notes list and in each
  editor's gutter markers, which carry text labels.
- One `<h1>` (the name), a "Skip to content" control as the first tab stop, headings in order
  (views use `h2`, their sections `h3`, dialogs `h2`).
- Result changes are announced through one polite live region: "Translated. Needs review, 2 notes."
- Playwright + axe run on every view in both themes in CI.

## Definition of done for the UI milestone

A screenshot review in both themes at 1440, 1024 and 390 px; axe clean; the offline network test
passing; Lighthouse performance ≥ 95 on the built site; every state in the table above reachable in a
Playwright test.
