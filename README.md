# bstack

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/bstack)](https://npmx.dev/package/bstack)

Turn local commits into a native GitHub stack of pull requests. Each commit becomes its own PR, based on the one before it, so reviewers see small, focused diffs while you keep working.

```
  feat/user-auth
  ○ feat(db): add user schema       ──► #101
  ○ feat(api): add auth endpoints   ──► #102
  ○ feat(ui): add login page        ──► #103
```

## Install

Pick one:

```bash
# Standalone binary for macOS or Linux, installed to ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/wsehl/bstack/main/install.sh | sh

# npm, pnpm, or bun (needs Node.js 20 or newer)
npm install -g --ignore-scripts bstack
pnpm add -g --ignore-scripts bstack
bun add -g --ignore-scripts bstack
```

bstack drives the [GitHub CLI](https://cli.github.com/) and its [gh-stack](https://github.com/github/gh-stack) extension, so install and authenticate them too:

```bash
gh auth login
gh extension install github/gh-stack
```

### Update

```bash
bstack update   # or: bstack upgrade
```

## How it works

bstack pushes one remote branch per commit and opens one PR for each. The first PR targets your base branch and every later PR targets the branch before it. gh-stack then links them into a native GitHub stack.

Your local commits are the source of truth. bstack remembers the PRs it opened, and each run makes GitHub match your branch again: it creates, updates, reorders, or closes PRs as needed and leaves the rest alone. Running it twice changes nothing.

## Usage

### Start a stack

Create a branch, make one reviewable change per commit, and run `bstack`:

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

Add `--dry-run` to preview which PRs would be created, updated, or closed.

### Add a commit

```bash
git commit -am "feat(api): add rate limiting"
bstack
```

```diff
  ○ feat(ui): add login page        ──► #103
+ ○ feat(api): add rate limiting    ──► #104  created
```

### Edit a commit

Amend the latest commit, or use interactive rebase for an older one:

```bash
git rebase -i main   # mark the commit as 'edit'
git commit --amend && git rebase --continue
bstack
```

```diff
  ○ feat(db): add user schema       ──► #101  unchanged
  ○ feat(api): add auth endpoints   ──► #102  updated
  ○ feat(ui): add login page        ──► #103  updated
```

bstack force-pushes the rewritten branches. Editing a commit also updates every PR above it.

### Reorder, squash, or drop commits

Rewrite the branch with `git rebase -i main`, then run `bstack`. PR numbers follow their commits:

```diff
- ○ feat(db): add user schema       ──► #101
- ○ feat(api): add auth endpoints   ──► #102
+ ○ feat(api): add auth endpoints   ──► #102
+ ○ feat(db): add user schema       ──► #101
  ○ feat(ui): add login page        ──► #103
```

A `fixup` folds into its parent PR, and a dropped commit closes its PR:

```diff
  ○ feat(db): add user schema       ──► #101
- ○ feat(api): add auth endpoints   ──► #102  closed
  ○ feat(ui): add login page        ──► #103  updated
```

bstack remembers which branch each stack was synced from. If your commits match a stack synced from another branch, for example after cherry-picking into a new branch, bstack won't close that stack's other PRs unless you pass `--close-omitted`.

### After a PR merges

Rebase onto the updated base and sync:

```bash
git rebase main
bstack
```

```diff
- ○ feat(db): add user schema       ──► #101  merged
  ○ feat(api): add auth endpoints   ──► #102
  ○ feat(ui): add login page        ──► #103
```

The merged PR leaves the stack and the rest keep their numbers.

### Check out a stack

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
| `--dry-run`       | Preview PR and stack changes without rewriting or pushing         |
| `--close-omitted` | Allow closing PRs of a stack last synced from another branch      |
| `--verbose`       | Print every git/gh command before it runs                         |
| `--same-base`     | Refuse checkout if it would change the current merge base         |

## Rules

- **One commit, one PR.** bstack owns its branches and PRs. Don't push or edit them by hand.
- **Rebase, don't merge.** When `main` moves, run `git rebase main` instead of merging it in.
- **Run `bstack` after every change.** It only touches what changed.

## References

- [ezyang/ghstack](https://github.com/ezyang/ghstack)
- [github/gh-stack](https://github.com/github/gh-stack)
- [stacking.dev](https://www.stacking.dev/)
