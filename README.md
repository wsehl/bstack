# bstack

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/bstack)](https://npmx.dev/package/bstack)

Turn local commits into a GitHub stack of pull requests. Each commit becomes its own PR, stacked on top of the previous one. Reviewers see small, focused diffs. You keep working without waiting for merges.

```
  feat/user-auth
  ○ feat(db): add user schema       ──► #101
  ○ feat(api): add auth endpoints   ──► #102
  ○ feat(ui): add login page        ──► #103
```

## Install

```bash
npm install -g bstack
```

Install and authenticate the [GitHub CLI](https://cli.github.com/), plus the [gh-stack](https://github.com/github/gh-stack) extension:

```bash
gh auth login
gh extension install github/gh-stack
```

bstack drives gh-stack to link the PRs into a native GitHub stack, so GitHub shows the stack structure right on the PRs.

## How it works

bstack pushes one remote branch per commit and opens one PR for each. The first PR targets your base branch, and every PR after it targets the branch before it, so the PRs form a stack.

bstack remembers the PRs it opened between runs. When you run `bstack` again, it compares against what it remembers and only touches what changed.

## Usage

### Start a stack

Create a branch from `main`, commit one reviewable change per commit, then run `bstack`:

```bash
git switch -c feat/user-auth main
git commit -am "feat(db): add user schema"
git commit -am "feat(api): add auth endpoints"
git commit -am "feat(ui): add login page"
bstack
```

```diff
  feat/user-auth
+ ○ feat(db): add user schema       ──► #101  created
+ ○ feat(api): add auth endpoints   ──► #102  created
+ ○ feat(ui): add login page        ──► #103  created
```

bstack pushes dedicated remote branches and opens one PR per commit. Add `--dry-run` to preview first.

### Add a commit

Commit on top of the stack, then run `bstack` again:

```bash
git commit -am "feat(api): add rate limiting"
bstack
```

```diff
  ○ feat(ui): add login page        ──► #103
+ ○ feat(api): add rate limiting    ──► #104  created
```

Existing PRs are untouched. bstack only opens what's new.

### Edit a commit

Amend the latest commit, then sync:

```bash
git commit --amend && bstack
```

For an older commit, use interactive rebase:

```bash
git rebase -i main   # mark the commit as 'edit'
git commit --amend && git rebase --continue
bstack
```

```diff
  ○ feat(db): add user schema       ──► #101  unchanged
  ○ feat(api): add auth endpoints   ──► #102  unchanged
  ○ feat(ui): add login page        ──► #103  updated
```

bstack force-pushes the rewritten branches and updates the affected PRs. Editing an older commit also updates every PR above it.

### Reorder commits

Reorder commits with interactive rebase, then run `bstack`:

```bash
git rebase -i main   # swap lines to reorder
bstack
```

```diff
- ○ feat(db): add user schema       ──► #101
- ○ feat(api): add auth endpoints   ──► #102
+ ○ feat(api): add auth endpoints   ──► #102
+ ○ feat(db): add user schema       ──► #101
  ○ feat(ui): add login page        ──► #103
```

PR numbers follow their commits. bstack rebuilds the stack in the new order and re-points the PR bases.

### Squash a commit

Use `fixup` in interactive rebase to fold a commit into its parent, then sync:

```bash
git rebase -i main   # mark a commit as 'fixup'
bstack
```

```diff
  ○ feat(db): add user schema       ──► #101  updated
- ○ fixup! add user schema
  ○ feat(api): add auth endpoints   ──► #102
  ○ feat(ui): add login page        ──► #103
```

The fixup folds into the parent PR. The stack contracts, and the parent PR is updated in place.

### Drop a commit

Delete a commit from the stack with interactive rebase, then sync:

```bash
git rebase -i main   # mark a commit as 'drop'
bstack
```

```diff
  ○ feat(db): add user schema       ──► #101
- ○ feat(api): add auth endpoints   ──► #102  closed
  ○ feat(ui): add login page        ──► #103  updated
```

The dropped PR closes. The PRs above it are rebased onto their new parents.

### After a PR merges

When a lower PR merges, rebase your branch onto the updated base and sync:

```bash
git rebase main
bstack
```

```diff
- ○ feat(db): add user schema       ──► #101  merged
  ○ feat(api): add auth endpoints   ──► #102
  ○ feat(ui): add login page        ──► #103
+ ○ feat(ui): add logout            ──► #104  created
```

The merged PR leaves the stack. Surviving PRs keep their numbers, and new commits append to the stack.

### Checkout an existing stack

Jump to any stack by PR number or URL:

```bash
bstack checkout 123
bstack checkout https://github.com/owner/repo/pull/123
```

## Options

| Flag              | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `--base <branch>` | Stack base branch (default: repo default branch)                  |
| `--remote <name>` | Git remote to push to (default: `remote.pushDefault` or `origin`) |
| `--draft`         | Create PRs as drafts instead of ready-for-review                  |
| `--dry-run`       | Preview what bstack would do without pushing anything             |
| `--verbose`       | Print every git/gh command before it runs                         |
| `--same-base`     | Refuse checkout if it would change the current merge base         |

## Rules

- **One commit = one PR.** Don't push the bstack branches or open PRs manually. bstack owns them.
- **No merge commits.** When `main` moves, rebase your branch onto it (`git rebase main`) instead of merging.
- **Run `bstack` after every change.** It's idempotent. Running it twice changes nothing.

## References

- [ezyang/ghstack](https://github.com/ezyang/ghstack)
- [github/gh-stack](https://github.com/github/gh-stack)
- [stacking.dev](https://www.stacking.dev/)
