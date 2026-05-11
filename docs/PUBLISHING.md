# Publishing Notes

This project is intended to be publishable without exposing local credentials,
private registry URLs, or internal filesystem paths.

## Security checklist before open sourcing

- Do not commit `.npmrc`, `.env`, npm tokens, API keys, or registry credentials.
- Rotate any credential that was ever committed, even if it has since been
  removed from the current tree.
- Rewrite repository history before making the repository public if committed
  secrets existed in earlier commits.
- Re-run a secret scan against the final public branch.
- Confirm every runtime dependency is available from the registry that users
  will install from.

## Package contents

`package.json` uses a `files` allowlist. The npm package should contain only:

```text
dist/
schemas/
examples/
README.md
SECURITY.md
package.json
```

This avoids publishing source tests, local development notes, and internal docs
unless they are intentionally added to the allowlist.

Runtime dependencies are bundled into the npm tarball through
`bundledDependencies`, including `@octopus/engine`.

## Release script

Use the repository release script for normal npm releases:

```bash
npm run release -- patch --dry-run
npm run release -- patch
```

The script:

1. Verifies the working tree is clean.
2. Runs the test suite.
3. Runs `npm pack --dry-run`.
4. Bumps the version with `npm version`.
5. Publishes to npm with public access.
6. Pushes the version commit and git tag.

Use `minor`, `major`, or an exact version when needed:

```bash
npm run release -- minor
npm run release -- 0.2.0
```

If npm asks for a one-time password and the script fails after creating the
version commit/tag, finish manually:

```bash
npm --cache /tmp/octoparse-npm-cache publish --access public --otp=<code>
git push origin HEAD --tags
```

## Manual release checklist

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

Inspect the dry-run output before publishing. If your local npm cache has
permission problems, use a temporary cache:

```bash
npm --cache /tmp/octoparse-npm-cache pack --dry-run
```

## Publish

For public npm:

```bash
npm login
npm --cache /tmp/octoparse-npm-cache publish --access public
```

For scoped packages, make sure the package name, organization, and visibility
match the intended npm target before publishing.

## Post-publish smoke test

Use a clean directory or clean machine:

```bash
npm install -g octoparse-cli
octoparse --help
octoparse doctor
```

If `@octopus/engine` is not publicly installable, publish or replace that
runtime dependency before publishing this CLI publicly.
