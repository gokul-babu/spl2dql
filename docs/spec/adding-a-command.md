# Adding or changing an SPL command

Follow the steps in order. Do not skip the spec and case steps to get to the code.

## 1. Read the mapping

Open `docs/spec/spl-dql-mapping.md` and find the command's row: tier, DQL template, supported
arguments, semantic notes, diagnostic codes, provenance.

- If the command has no row, or its row is marked `inf` (inferred), stop and establish the mapping
  first: check Splunk's Search Reference for the exact syntax and the vendored DQL reference under
  `third_party/` for the target. Write the row into the spec before any code.
- If you have a Dynatrace tenant, confirm the DQL template there (`dtctl verify query`, or a
  notebook).

## 2. Write the conformance cases first

In the matching `packages/conformance/cases/<area>.md`, following `docs/spec/testing.md`:

- the simplest form;
- one case per supported argument;
- one case per unsupported argument, expecting its diagnostic;
- one case with the command inside a longer pipeline;
- for a T3 command, a single case in `cases/unsupported.md`.

Expected DQL comes from the spec row, written by hand. Run the suite and confirm the new cases
fail for the right reason.

## 3. Implement the module

Add a `CommandDef` to the right family file in `packages/core/src/commands/` (or
`notTranslated(...)` in `generating.ts` for a T3 command) and include it in that file's exported
list so `registry.ts` picks it up:

- `lower(st)` — read arguments with `st.scanner()` and the parsers in `src/spl/`; turn SPL fields
  into DQL fields only with `st.field()`; emit with `st.emit(cmd(...))`; report notes with
  `st.report(code, span, { detail })`.
- For anything that cannot be translated, `throw new Untranslatable(code, span, detail)`.

eval functions go in `src/lower/expr.ts`, aggregations in `src/lower/aggs.ts`. A new diagnostic code
is a spec change: add it to the catalogue in `docs/spec/spl-dql-mapping.md` §2 and to
`src/diagnostics/registry.ts` in the same change.

## 4. Unit-test what the corpus cannot

Add edge cases (argument parsing, malformed input) to `packages/core/test/units.test.ts` when the
corpus cannot express them.

## 5. Check

- `pnpm check` passes.
- `listCommands()` shows the command with the right tier (it feeds the Reference page and
  `spl2dql commands`).
- Translate two or three realistic searches using the command through the CLI and read the output.

## 6. In the pull request

State the tier, what is and is not supported, and any `inf` items that still need checking on a
tenant.
