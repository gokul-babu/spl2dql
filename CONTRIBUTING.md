# Contributing

Thank you for helping. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- A search that translates wrongly is the most useful report there is. Use the issue form and
  replace every real name and value with a made-up one first — issues are public.
- Two things are out of scope for good: connecting to a Dynatrace tenant, and AI of any kind.
  The tool stays offline and deterministic.
- For anything larger than a fix, open an issue first so the approach can be agreed.

## Working on the code

1. Read "Rules that are never broken" below; `docs/ARCHITECTURE.md` shows where everything lives
   and the README's Documentation table lists each specification.
2. Toolchain: `mise install` (Node and pnpm versions are pinned in `mise.toml`), then `pnpm install`.
3. Switch the commit hook on, once per clone: `git config core.hooksPath .githooks`. It scans
   what you are about to commit for anything that looks like a credential (it needs
   [gitleaks](https://github.com/gitleaks/gitleaks); CI runs the same scan) and checks formatting.
4. Before opening a pull request: `pnpm build && pnpm check && pnpm test:e2e`.
5. A change in translation behaviour updates three things together: the code, the conformance cases
   in `packages/conformance/cases/`, and the section of `docs/spec/spl-dql-mapping.md` it follows.
   Expected DQL is written from the spec or documentation, never copied from the tool's own output.
6. Adding an SPL command: follow `docs/spec/adding-a-command.md`.
7. `packages/cli/src/serve` is security-sensitive: keep it loopback-only, GET/HEAD-only and
   API-free; `packages/cli/test/serve.test.ts` covers each rule. The product has no online features
   and will not get any.
8. `examples/splunk-app` is the shared fixture for dashboards and Splunk configuration files. Add a
   case there when you add a shape the readers must handle, and keep it made up: no real names.

## Rules that are never broken

1. `packages/core` has zero runtime dependencies and uses no Node, DOM or network API.
2. No network code. `core` and `apps/web` never call `fetch` or any equivalent, and the CLI opens no
   outbound connection (`spl2dql serve` only listens on loopback). `pnpm boundaries` enforces it.
3. `translate()` never throws on user input and is deterministic: no clock, randomness or locale.
4. DQL text is produced only by the printer, from a DQL AST. No string-built DQL anywhere else.
5. Never guess environment names. An unknown index, sourcetype, field, macro or lookup becomes a
   diagnostic and a visible placeholder, resolved through the mapping file.
6. Expected DQL in the conformance cases comes from the spec or documentation, never from the
   tool's own output. Do not edit an expected block to make a test pass without citing a source.
7. No AI. Output is deterministic.
8. No credentials. Nothing reads a secret or a token, and nothing connects to a tenant.
9. No AGPL or GPL code, and nothing copied from a repository without a recognised licence.
10. Do not write DQL syntax from memory: check `docs/spec/spl-dql-mapping.md` or the vendored
    reference under `third_party/`.
11. A dashboard panel goes live only when its search translated completely. Anything else becomes
    a text tile that keeps the Splunk search.
12. A new file at the top level or a new document under `docs/` is added to
    `scripts/check-tree.ts` first; the check fails on anything tracked outside its list.

## What you may contribute

- **Your own work, signed off.** Contributions are accepted under the project's licence
  (Apache-2.0). Add a `Signed-off-by` line to every commit (`git commit -s`); with it you state
  that you wrote the change or otherwise have the right to submit it, as described in the
  [Developer Certificate of Origin](https://developercertificate.org/).
- **Nothing from a real environment.** No real searches, dashboards, host names, people or
  customer names — in code, tests, fixtures, issues or screenshots.
- **Nothing copied from Splunk's or Dynatrace's products or from repositories without a licence
  that allows it.** No AGPL or GPL code (ADR-012). Documentation is a source for behaviour, not
  for text to paste.
- **No logos or brand artwork** of Splunk, Cisco or Dynatrace.

## Releases

See [docs/RELEASING.md](docs/RELEASING.md).
