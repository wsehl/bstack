# bstack

Convert a series of commits in a local branch into a native GitHub stack of pull requests.

## Install

```bash
npm install -g bstack
```

Install and authenticate the GitHub CLI with the `github/gh-stack` extension:

```
gh auth login
gh extension install github/gh-stack
```

## Use

Create one commit per change, then sync the stack:

```bash
git switch -c my-feature
git commit -am "feat: add the model"
git commit -am "feat: add the API"
bstack
```

Run `bstack` again after amending or rebasing commits.

New PRs are ready for review by default. Pass `--draft` to create draft PRs.

Checkout a stack through one of its PRs:

```bash
bstack checkout 123
bstack checkout https://github.com/owner/repo/pull/123
```

Use `--dry-run` to inspect without syncing and `--quiet` to hide progress logs.

## References

- [ezyang/ghstack](https://github.com/ezyang/ghstack)
- [github/gh-stack](https://github.com/github/gh-stack)
