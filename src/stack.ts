import { addChangeId, generateChangeId, splitCommitMessage } from "./commit";
import type { CommitRewrite } from "./git";
import type {
  Commit,
  PullRequest,
  RepositoryState,
  StackChange,
  StoredStack,
} from "./model";

export type StackTransition =
  | { kind: "full" }
  | {
      kind: "rebuild";
      stackNumber: number;
      action: "insert" | "remove" | "reorder" | "update";
    }
  | { kind: "collapse"; stackNumber: number }
  | { kind: "skip" }
  | { kind: "partial"; previousOffset: number }
  | { kind: "append"; stackNumber: number; branches: string[] };

export type StackTransitionLookups = {
  pullRequestState(pullRequest: number): PullRequest["state"];
  stackNumberForPullRequest(pullRequest: number): number | undefined;
};

export type StackTransitionOptions = {
  preserveHigherChanges: boolean;
  lookups: StackTransitionLookups;
};

export interface CommitRewriter {
  rewriteCommits(rewrites: readonly CommitRewrite[]): string[];
}

export class Stack {
  private constructor(
    readonly changes: readonly StackChange[],
    readonly rewritten = false,
    private readonly rewrites: readonly CommitRewrite[] = [],
  ) {
    if (changes.length === 0) {
      throw new Error("A stack must contain at least one change");
    }

    const seen = new Set<string>();
    const duplicate = changes.find((change) => {
      if (seen.has(change.id)) {
        return true;
      }
      seen.add(change.id);

      return false;
    });
    if (duplicate) {
      throw new Error(
        `A stack cannot contain duplicate bstack-id ${duplicate.id}`,
      );
    }
  }

  static fromChanges(changes: readonly StackChange[]) {
    return new Stack(changes);
  }

  static fromCommits(commits: readonly Commit[], userLogin: string) {
    const ids = commits.map((commit) => commit.changeId ?? generateChangeId());
    const rewritten = commits.some((commit) => commit.changeId === undefined);
    const rewrites = rewritten
      ? commits.map((commit, index) => ({
          commit,
          message: commit.changeId
            ? commit.message
            : addChangeId(commit.message, ids[index]!),
        }))
      : [];
    const changes = commits.map((commit, index) => {
      const id = ids[index]!;
      const { subject, body } = splitCommitMessage(commit.message);

      return {
        id,
        oid: commit.oid,
        subject,
        body,
        remoteBranch: `bstack/${userLogin}/${id}`,
      };
    });

    return new Stack(changes, rewritten, rewrites);
  }

  writeChangeIds(repository: CommitRewriter) {
    if (!this.rewritten) {
      return this;
    }

    const rewrittenOids = repository.rewriteCommits(this.rewrites);
    if (rewrittenOids.length !== this.changes.length) {
      throw new Error(
        `Git rewrote ${rewrittenOids.length} commits for a stack with ${this.changes.length} changes`,
      );
    }
    const changes = this.changes.map((change, index) => ({
      ...change,
      oid: rewrittenOids[index]!,
    }));

    return new Stack(changes, true);
  }

  findPrevious(state: RepositoryState) {
    const ids = new Set(this.changes.map((change) => change.id));
    const matches = state.stacks.filter((stack) =>
      stack.changes.some((change) => ids.has(change.id)),
    );

    if (matches.length > 1) {
      throw new Error(
        "The current commits match more than one stored bstack stack",
      );
    }

    return matches[0];
  }

  transitionFrom(
    previous: StoredStack | undefined,
    options: StackTransitionOptions,
  ) {
    if (!previous) {
      return { kind: "full" } satisfies StackTransition;
    }
    const previousIds = previous.changes.map((change) => change.id);
    const currentIds = this.changes.map((change) => change.id);
    const previousIdSet = new Set(previousIds);
    const currentIdSet = new Set(currentIds);
    const removed = previous.changes.filter(
      (change) => !currentIdSet.has(change.id),
    );
    const added = this.changes.filter(
      (change) => !previousIdSet.has(change.id),
    );

    if (removed.length === 0) {
      const previousIsPrefix = previousIds.every(
        (id, index) => currentIds[index] === id,
      );
      if (previousIsPrefix && added.length === 0) {
        return { kind: "skip" } satisfies StackTransition;
      }
      if (previousIsPrefix) {
        const stackNumber =
          previous.stackNumber ??
          options.lookups.stackNumberForPullRequest(
            previous.changes[0]!.pullRequest,
          );
        if (stackNumber !== undefined) {
          return {
            kind: "append",
            stackNumber,
            branches: added.map((change) => change.remoteBranch),
          } satisfies StackTransition;
        }

        return { kind: "full" } satisfies StackTransition;
      }
      const stackNumber =
        previous.stackNumber ??
        options.lookups.stackNumberForPullRequest(
          previous.changes[0]!.pullRequest,
        );

      return stackNumber === undefined
        ? ({ kind: "full" } satisfies StackTransition)
        : ({
            kind: "rebuild",
            stackNumber,
            action: added.length === 0 ? "reorder" : "insert",
          } satisfies StackTransition);
    }

    const firstCurrentIndex = previousIds.indexOf(currentIds[0]!);
    const isPreviousSlice =
      firstCurrentIndex >= 0 &&
      currentIds.every(
        (id, index) => previousIds[firstCurrentIndex + index] === id,
      );
    if (
      options.preserveHigherChanges &&
      added.length === 0 &&
      isPreviousSlice &&
      firstCurrentIndex + currentIds.length < previousIds.length
    ) {
      const removedPrefix = previous.changes.slice(0, firstCurrentIndex);
      const prefixWasMerged = removedPrefix.every(
        (change) =>
          options.lookups.pullRequestState(change.pullRequest) === "MERGED",
      );
      if (prefixWasMerged) {
        return {
          kind: "partial",
          previousOffset: firstCurrentIndex,
        } satisfies StackTransition;
      }
    }

    const removedIsPrefix = removed.every(
      (change, index) => previous.changes[index] === change,
    );
    const removedPrefixWasMerged =
      removedIsPrefix &&
      removed.every(
        (change) =>
          options.lookups.pullRequestState(change.pullRequest) === "MERGED",
      );
    const survivingIds = previousIds.slice(removed.length);
    const onlyAppendedAfterMergedPrefix =
      removedPrefixWasMerged &&
      survivingIds.every((id, index) => currentIds[index] === id) &&
      currentIds
        .slice(survivingIds.length)
        .every((id) => !previousIdSet.has(id));

    if (removedPrefixWasMerged && added.length === 0) {
      return { kind: "skip" } satisfies StackTransition;
    }
    if (onlyAppendedAfterMergedPrefix) {
      if (previous.stackNumber === undefined) {
        throw new Error(
          "Cannot append after a merge because the native GitHub stack number is missing from local state",
        );
      }

      return {
        kind: "append",
        stackNumber: previous.stackNumber,
        branches: added.map((change) => change.remoteBranch),
      } satisfies StackTransition;
    }

    const stackNumber =
      previous.stackNumber ??
      options.lookups.stackNumberForPullRequest(
        previous.changes[0]!.pullRequest,
      );
    if (stackNumber === undefined) {
      throw new Error(
        "Cannot remove submitted commits because the native GitHub stack number is missing from local state",
      );
    }
    if (this.changes.length === 1) {
      return { kind: "collapse", stackNumber } satisfies StackTransition;
    }

    return {
      kind: "rebuild",
      stackNumber,
      action: added.length === 0 ? "remove" : "update",
    } satisfies StackTransition;
  }
}
