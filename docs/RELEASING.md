# Releasing

Both packages (`@spl2dql/core`, `spl2dql`) are released together under one version. A release is a
tag; `.github/workflows/release.yml` does the rest. No npm token is stored anywhere: npm trusts
that workflow directly ("trusted publishing"), and every release carries a provenance statement
that links the package to the commit and the workflow run that built it.

## Version numbers

Semantic versioning. Before 1.0.0: a patch release fixes things; a minor release may change how a
search translates or add features. After 1.0.0: a change in the DQL produced for a search that
translated before is a minor release when the old output was wrong and a major release otherwise.

## Steps

1. On a branch from `main`, with a clean tree: set the new version, the same number everywhere, in
   the four `package.json` files (`packages/core`, `packages/cli`, `apps/web`,
   `packages/conformance`) and in the two constants named `VERSION` (`packages/core/src/index.ts`,
   and `packages/cli/src/main.ts`, which `spl2dql --version` prints). A test fails when one of
   them lags behind.
2. In `CHANGELOG.md`, rename "Unreleased" to `[X.Y.Z] - YYYY-MM-DD` and add an empty "Unreleased"
   above it. Write the section for a person who uses the tool, not for one who reads the code.
3. `pnpm install` (the lockfile must not change), then
   `pnpm build && pnpm check && pnpm test:e2e && node scripts/check-packages.ts`.
4. Commit ("Release X.Y.Z"), open a pull request, merge it when CI is green.
5. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. The release workflow checks that the tag is on `main` and matches both versions and the
   changelog, runs every check again from scratch, packs both packages, looks inside them, waits
   for approval if the `npm` environment has reviewers, publishes to npm, creates the GitHub
   release with the changelog section, and deploys the web app to Cloudflare Pages.
7. Check https://www.npmjs.com/package/spl2dql (the provenance badge), run
   `npx spl2dql@X.Y.Z --version`, and open https://spl2dql.pages.dev (About shows the version).

If a job fails after one package was published, fix the cause and re-run the failed jobs: a version
that is already on npm is skipped. A published version is never replaced; a mistake is fixed by the
next patch release (and `npm deprecate` for the bad one).

## One-time setup (the owner)

**npm** — for each of `spl2dql` and `@spl2dql/core`, at npmjs.com → the package → Settings:

- Trusted publisher → GitHub Actions: user `gokul-babu`, repository `spl2dql`, workflow
  `release.yml`, environment `npm`. The values are case-sensitive and are only checked when a
  release runs.
- Publishing access → "Require two-factor authentication and disallow tokens".

The very first version of a package has to exist before its settings page does, so 0.1.0 was
published by hand from a clean checkout of the tagged commit.

**GitHub** — Settings → Environments:

- `npm`: add yourself as required reviewer, and limit it to tags matching `v*`.
- `site`: the secrets `CLOUDFLARE_API_TOKEN` (a token with only "Cloudflare Pages: Edit" on the
  account) and `CLOUDFLARE_ACCOUNT_ID`. Without them the release still succeeds and says that the
  page was not deployed.

**Cloudflare** — the Pages project `spl2dql` is a Direct Upload project. Leave Web Analytics and
every feature that adds a script to the page switched off: the page promises that nothing leaves
the browser (ADR-028).

## Deploying the page by hand

```
pnpm build
npx wrangler@4 pages deploy apps/web/dist --project-name spl2dql --branch main
```

A deployment with any other `--branch` is a preview at its own address and does not change the
public page.
