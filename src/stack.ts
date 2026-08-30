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
      action: "change-base" | "insert" | "remove" | "reorder" | "update";
    }
  | { kind: "collapse"; stackNumber: number }
  | { kind: "retarget" }
  | { kind: "skip" }
  | { kind: "partial"; previousOffset: number }
  | { kind: "append"; stackNumber: number; branches: string[] };

export type StackTransitionLookups = {
  pullRequestState(pullRequest: number): PullRequest["state"];
  stackNumberForPullRequest(pullRequest: number): number | undefined;
};

export type StackTransitionOptions = {
  base: string;
  preserveHigherChanges: boolean;
  lookups: StackTransitionLookups;
};

type TransitionContext = {
  previous: StoredStack;
  options: StackTransitionOptions;
  previousIds: string[];
  currentIds: string[];
  previousIdSet: ReadonlySet<string>;
  removed: StoredStack["changes"];
  added: readonly StackChange[];
  baseChanged: boolean;
};

export class Stack {
  private constructor(
    readonly changes: readonly StackChange[],
    readonly rewritten = false,
    readonly commitRewrites: readonly CommitRewrite[] = [],
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

  withRewrittenOids(rewrittenOids: readonly string[]) {
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
  ): StackTransition {
    if (!previous) {
      return { kind: "full" };
    }

    const context = this.transitionContext(previous, options);

    if (context.removed.length === 0) {
      return this.transitionWithoutRemovedChanges(context);
    }

    const partial = this.partialTransition(context);

    return partial ?? this.transitionWithRemovedChanges(context);
  }

  private transitionContext(
    previous: StoredStack,
    options: StackTransitionOptions,
  ): TransitionContext {
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
    const baseChanged = previous.base !== options.base;

    return {
      previous,
      options,
      previousIds,
      currentIds,
      previousIdSet,
      removed,
      added,
      baseChanged,
    };
  }

  private transitionWithoutRemovedChanges(
    context: TransitionContext,
  ): StackTransition {
    const previousIsPrefix = isPrefix(context.previousIds, context.currentIds);

    if (!previousIsPrefix) {
      return this.transitionForChangedOrder(context);
    }

    if (context.added.length === 0) {
      return context.baseChanged
        ? this.transitionForChangedBase(context.previous, context.options)
        : { kind: "skip" };
    }

    if (context.baseChanged) {
      return this.transitionForChangedBase(context.previous, context.options);
    }

    const stackNumber = this.stackNumber(context);

    if (stackNumber === undefined) {
      return { kind: "full" };
    }

    return {
      kind: "append",
      stackNumber,
      branches: context.added.map((change) => change.remoteBranch),
    };
  }

  private transitionForChangedOrder(
    context: TransitionContext,
  ): StackTransition {
    const stackNumber = this.stackNumber(context);

    if (stackNumber === undefined) {
      return { kind: "full" };
    }

    return {
      kind: "rebuild",
      stackNumber,
      action: context.added.length === 0 ? "reorder" : "insert",
    };
  }

  private partialTransition(
    context: TransitionContext,
  ): StackTransition | undefined {
    const firstCurrentIndex = context.previousIds.indexOf(
      context.currentIds[0]!,
    );

    if (!canPreserveHigherChanges(context, firstCurrentIndex)) {
      return undefined;
    }

    const removedPrefix = context.previous.changes.slice(0, firstCurrentIndex);

    if (!allPullRequestsMerged(removedPrefix, context.options.lookups)) {
      return undefined;
    }

    if (context.baseChanged) {
      throw new Error(
        "Cannot change the stack base while preserving higher pull requests from a detached checkout",
      );
    }

    return {
      kind: "partial",
      previousOffset: firstCurrentIndex,
    };
  }

  private transitionWithRemovedChanges(
    context: TransitionContext,
  ): StackTransition {
    const removedPrefixWasMerged = isMergedPrefix(context);
    const survivingIds = context.previousIds.slice(context.removed.length);
    const survivingOrderIsUnchanged = survivingIds.every(
      (id, index) => context.currentIds[index] === id,
    );

    if (
      removedPrefixWasMerged &&
      context.added.length === 0 &&
      survivingOrderIsUnchanged
    ) {
      return context.baseChanged
        ? this.transitionForChangedBase(context.previous, context.options)
        : { kind: "skip" };
    }

    if (
      isAppendAfterMergedPrefix(
        context,
        survivingIds.length,
        survivingOrderIsUnchanged,
        removedPrefixWasMerged,
      )
    ) {
      if (context.baseChanged) {
        return this.transitionForChangedBase(context.previous, context.options);
      }
      if (context.previous.stackNumber === undefined) {
        throw new Error(
          "Cannot append after a merge because the native GitHub stack number is missing from local state",
        );
      }

      return {
        kind: "append",
        stackNumber: context.previous.stackNumber,
        branches: context.added.map((change) => change.remoteBranch),
      };
    }

    const stackNumber = this.stackNumber(context);

    if (stackNumber === undefined) {
      throw new Error(
        "Cannot remove submitted commits because the native GitHub stack number is missing from local state",
      );
    }
    if (this.changes.length === 1) {
      return { kind: "collapse", stackNumber };
    }

    return {
      kind: "rebuild",
      stackNumber,
      action: removalAction(context.added.length, removedPrefixWasMerged),
    };
  }

  private stackNumber(context: TransitionContext): number | undefined {
    if (context.previous.stackNumber !== undefined) {
      return context.previous.stackNumber;
    }

    return context.options.lookups.stackNumberForPullRequest(
      context.previous.changes[0]!.pullRequest,
    );
  }

  private transitionForChangedBase(
    previous: StoredStack,
    options: StackTransitionOptions,
  ): StackTransition {
    if (this.changes.length === 1) {
      return { kind: "retarget" };
    }

    const stackNumber =
      previous.stackNumber ??
      options.lookups.stackNumberForPullRequest(
        previous.changes[0]!.pullRequest,
      );

    return stackNumber === undefined
      ? { kind: "full" }
      : { kind: "rebuild", stackNumber, action: "change-base" };
  }
}

function isPrefix(
  prefix: readonly string[],
  values: readonly string[],
): boolean {
  return prefix.every((id, index) => values[index] === id);
}

function canPreserveHigherChanges(
  context: TransitionContext,
  firstCurrentIndex: number,
): boolean {
  const isPreviousSlice =
    firstCurrentIndex >= 0 &&
    context.currentIds.every(
      (id, index) => context.previousIds[firstCurrentIndex + index] === id,
    );
  const hasHigherChanges =
    firstCurrentIndex + context.currentIds.length < context.previousIds.length;

  return (
    context.options.preserveHigherChanges &&
    context.added.length === 0 &&
    isPreviousSlice &&
    hasHigherChanges
  );
}

function allPullRequestsMerged(
  changes: StoredStack["changes"],
  lookups: StackTransitionLookups,
): boolean {
  return changes.every(
    (change) => lookups.pullRequestState(change.pullRequest) === "MERGED",
  );
}

function isMergedPrefix(context: TransitionContext): boolean {
  const removedIsPrefix = context.removed.every(
    (change, index) => context.previous.changes[index] === change,
  );

  return (
    removedIsPrefix &&
    allPullRequestsMerged(context.removed, context.options.lookups)
  );
}

function isAppendAfterMergedPrefix(
  context: TransitionContext,
  survivingCount: number,
  survivingOrderIsUnchanged: boolean,
  removedPrefixWasMerged: boolean,
): boolean {
  const appendedIdsAreNew = context.currentIds
    .slice(survivingCount)
    .every((id) => !context.previousIdSet.has(id));

  return (
    removedPrefixWasMerged && survivingOrderIsUnchanged && appendedIdsAreNew
  );
}

function removalAction(
  addedCount: number,
  removedPrefixWasMerged: boolean,
): "remove" | "reorder" | "update" {
  if (addedCount > 0) {
    return "update";
  }

  return removedPrefixWasMerged ? "reorder" : "remove";
}
