---
name: bstack
description: Create and maintain stacked GitHub pull requests with bstack, where each local commit becomes one PR. Use when the user requests bstack or the repository uses bstack for stacked PRs.
---

# bstack

bstack makes GitHub match a linear series of local commits. Each commit between the selected base and HEAD becomes one PR. Keep the work on one local branch, with one reviewable change per commit. Put prerequisites below changes that depend on them.

## Before using bstack

Read `bstack --help` for installed options. The CLI requires Git, authenticated `gh`, and the `github/gh-stack` extension. If a prerequisite is missing, report it rather than switching stack tools.

Inspect the current branch, working tree, and commits above the base. Use `--base <branch>` when the intended base differs from the repository default, and use the same base for later syncs. Commit subjects become PR titles; commit bodies become PR descriptions.

## Create and sync

Create a named branch from the intended base, implement the requested work, and commit each reviewable change separately. To preview and then publish draft PRs:

```bash
bstack --base main --draft --dry-run
bstack --base main --draft
```

Publishing needs authorization from the task. A dry run fetches the base and reads GitHub, but does not rewrite commits, push, or change PRs. `--draft` only affects newly created PRs.

Normal sync adds a `bstack-id` trailer to commits that lack one, which can change their hashes. Read the current log again after syncing before using commit hashes. Let bstack generate IDs for new changes.

Use bstack to manage its remote branches, PR titles, descriptions, bases, and native GitHub stack. Do not push those branches or edit those PR fields by hand, and do not run `gh stack init`, `add`, `submit`, or `sync` for this workflow.

## Edit a stack

Edit local commits, then preview and sync again with the same base. Keep each surviving commit's existing `bstack-id`: it preserves the PR number even when content, message, hash, or position changes.

- **Add:** make a new commit and sync. It becomes a new PR.
- **Amend:** stage the change and use `git commit --amend --no-edit` to retain the message and ID. To change a title or body, edit the message while retaining the ID trailer. Replacing the message with `--amend -m` can discard the ID.
- **Edit an older commit or reorder:** rebase the local series, retaining IDs. For non-interactive execution, use an explicit sequence editor rather than opening an interactive editor.
- **Squash or fix up:** keep only the surviving commit's ID in the combined message. Remove IDs belonging to absorbed commits; a commit with multiple IDs is invalid. The surviving PR remains and omitted open PRs close.
- **Drop:** remove the local commit and sync. On the named branch that owns the stack, omitted open PRs close. Merged PRs are historical state and are never closed.

Review the dry run before syncing a rewrite that closes or reorders PRs. Do not restore old local commits merely to match the current GitHub stack: local history is the source of truth.

A detached HEAD can represent a down-stack prefix; syncing it preserves higher PRs. A different named branch is protected from closing omitted PRs belonging to the original branch. Use `--close-omitted` only when the user intends those closures, not as a routine retry flag.

### Squash the entire stack

Record the current tip before rewriting and read the ID of the bottom commit whose PR should survive. With a clean working tree, `git reset --soft <parent-of-bottom-commit>` stages the complete stack while moving HEAD to its base. Then create a **new** commit with `git commit -F <message-file>`, including only the surviving ID in that message. Do not use `--amend` after resetting to the base: that would replace the base commit itself.

Before syncing, check that there is exactly one commit above the original base and run `git diff <saved-original-tip> HEAD --exit-code`. A squash must retain the original tree. If the diff is nonempty, recover the missing content from the saved tip before publishing; the surviving PR's remote branch contains only its former layer, not the complete stack.

## Checkout and merged PRs

Use `bstack checkout <PR-number-or-URL>` to check out existing work. Add `--same-base` if checkout must retain the current merge base.

After PRs merge, fetch and rebase onto the updated base, then sync the remaining commits. If a conflict occurs, resolve it within the Git rebase and preserve the surviving IDs. Do not merge the base into the local stack.

## Verify and recover

Compare the local commit count and order with the resulting PRs, and check PR numbers, titles, bases, and diffs. After an amendment or reorder, surviving IDs should still map to the same PR numbers. An unchanged second sync should report no changes.

Use `gh pr view <number> --json number,state,title,body,baseRefName,headRefName,isDraft` and `gh pr diff <number>` to inspect a PR. The bottom PR targets the selected base; each higher PR targets the preceding PR's head branch. For native stack membership and position, inspect `gh api repos/{owner}/{repo}/pulls/<number> --jq '.stack'` from the repository.

A native stack number is distinct from a PR number; do not pass it to `gh pr view`. Collapsing to one PR can remove native stack membership, so a null `.stack` is expected for that remaining PR.

`gh stack view` inspects gh-stack's local branch state, which bstack's working branch does not use. A "not part of a stack" error there does not mean the GitHub stack is missing. Verify through the PRs and API instead of initializing a second local stack.

If sync fails, inspect the error and current local/GitHub state before retrying. Some operations may already have completed. Fix the stated prerequisite or conflict; do not delete bstack state, regenerate existing IDs, or rebuild PRs manually to bypass the failure.
