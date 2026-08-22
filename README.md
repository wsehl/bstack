# bstack

Convert a series of commits in a local branch into a native GitHub stack of pull requests.

## Install

```bash
npm install -g bstack
```

Install and authenticate the [GitHub CLI](https://cli.github.com/) with the [stack](https://github.com/github/gh-stack) extension:

```
gh auth login
gh extension install github/gh-stack
```

## How to use

Write and edit commits locally. `bstack` handles the GitHub ops for you:

You

- Do not push your local feature branch.
- Do not open pull requests manually.
- Run `bstack` when your commits are ready. It pushes dedicated remote branches
  and creates one pull request for each commit.

### Start a stack

Create a local branch from `main`, then make one commit per reviewable change:

```bash
git switch main
git switch -c my-feature
git commit -am "feat: add the model"
git commit -am "feat: add the API"
bstack
```

That is the whole publishing flow. Keep working on the same local branch and run `bstack` again whenever the stack changes.

### Add another pull request

Add another commit on top of the stack, then run `bstack`:

```bash
git commit -am "feat: add validation"
bstack
```

`bstack` keeps the existing pull requests and adds one for the new commit.

### Modify a pull request

Edit the corresponding commit, then run `bstack` again. For the latest commit:

```bash
git commit --amend
bstack
```

For an older commit, use interactive rebase, mark that commit for editing, make
your changes, and continue the rebase:

```bash
git rebase -i main
git commit --amend
git rebase --continue
bstack
```

Stacks cannot contain merge commits.
When `main` moves, rebase your branch onto it instead of merging `main` into your branch.

### Checkout an existing stack

Use any pull request in the stack:

```bash
bstack checkout 123
bstack checkout https://github.com/owner/repo/pull/123
```

### Options

New pull requests are ready for review by default. Pass `--draft` to create
drafts instead.

Use `--dry-run` to inspect without syncing. Pass `--verbose` to print every
command before it runs.

## References

- [ezyang/ghstack](https://github.com/ezyang/ghstack)
- [github/gh-stack](https://github.com/github/gh-stack)
- [stacking.dev](https://www.stacking.dev/)
