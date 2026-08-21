# bstack

`bstack` turns a series of commits in local branch into native GitHub stacked separate pull requests.

## Install

Requirements: Bun, Git, an authenticated GitHub CLI, and the `github/gh-stack` extension.

```bash
gh extension install github/gh-stack
bun install --global bstack
```

## Use

Create one commit per reviewable change, then publish the stack:

```bash
git switch -c my-feature
git commit -am "Add the model"
git commit -am "Add the API"
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
