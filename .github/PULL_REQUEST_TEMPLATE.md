## What changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `pnpm build && pnpm check` passes
- [ ] `pnpm test:e2e` passes (for changes in `apps/web` or `packages/cli/src/serve`)
- [ ] A translation change updates the code, the conformance case and the spec section together,
      and the expected DQL comes from the spec or Dynatrace's documentation, not from the tool's output
- [ ] No network code, no credentials, no new runtime dependency in `packages/core`
- [ ] Commits are signed off (`git commit -s`), see CONTRIBUTING.md
- [ ] Nothing in the change comes from a real environment: no real host names, searches or people
