# bstack

`bstack` turns a series of commits on a local branch into native GitHub stacked pull requests.

## Install

Requirements:

- Node.js 20+
- `gh cli` plus the `github/gh-stack` extension (authenticated)

```bash
gh extension install github/gh-stack
npm install bstack -g
```

## Use

Create one commit per reviewable change, then publish the stack:

```bash
git switch -c my-feature
git commit -am "feat: add the model"
git commit -am "feat: add the API"
bstack
```

Run `bstack` again after amending or rebasing commits. New PRs are drafts unless you pass `--open`.

Checkout a stack through one of its PRs:

```bash
bstack checkout 123
bstack checkout https://github.com/owner/repo/pull/123
```

The first publish adds a stable `Bstack-Id` trailer to each commit and rewrites their hashes. The working tree must be clean. Merge commits and signed commits that need trailers are not supported.

Use `--dry-run` to inspect without publishing and `--quiet` to hide progress logs.

## Develop

Install dependencies and run the checks with pnpm:

```bash
pnpm install
pnpm run type-check
pnpm test
pnpm run lint
```

Build the Node.js CLI with tsdown:

```bash
pnpm run build
node dist/bstack.js --help
```
