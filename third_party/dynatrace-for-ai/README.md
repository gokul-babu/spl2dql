# Vendored: Dynatrace DQL reference

Source: https://github.com/Dynatrace/dynatrace-for-ai — `skills/dt-dql-essentials/references/`
Copied: 2026-11-14 from the locally installed plugin (version 7.0.0)
Licence: Apache-2.0 (see LICENSE in this folder). Files are unmodified.

Used only at build time by `scripts/gen-dql-catalog.ts` to generate
`packages/core/src/dql/catalog.generated.ts` (command names, function names and their named
parameters) for the offline syntax check. Nothing here is shipped verbatim.

## Dashboards

`dashboards/` — from `skills/dt-app-dashboards/` of the same repository and version (SKILL.md,
references/tiles.md, references/variables.md, references/create-update.md,
assets/ExampleDashboard.json, assets/visualization-settings.reference.jsonc). Copied 2026-11-16.
Licence: Apache-2.0. Files are unmodified.

Not used by any code. They are the reference `docs/spec/dashboards.md` cites for the shape of a
Dynatrace dashboard document: tile types, visualization names and the fields each needs, variable
definitions and how a query refers to a variable.
