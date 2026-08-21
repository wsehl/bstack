import type { GitRepository } from "./git";
import type { GitHubPlatform } from "./github";
import type {
  PullRequest,
  RepositoryState,
  StackChange,
  StoredStack,
} from "./model";
import type { Reporter } from "./reporter";
import { StateStore } from "./state";

export type SyncOptions = {
  base: string | undefined;
  remote: string | undefined;
  draft: boolean;
  dryRun: boolean;
  reporter: Reporter;
};

export type SyncResult = {
  base: string;
  remote: string;
  rewritten: boolean;
  changes: Array<StackChange & { pullRequest?: PullRequest }>;
};

export function syncStack(
  repository: GitRepository,
  github: GitHubPlatform,
  options: SyncOptions,
): SyncResult {
  const { reporter } = options;

  reporter.progress("Checking the repository and GitHub prerequisites");
  repository.assertReady();
  github.assertReady();

  const remote = repository.resolveRemote(options.remote);
  const base = options.base ?? github.defaultBranch();
  const userLogin = github.currentUserLogin();

  reporter.progress(
    `Using ${remote} as the remote and ${base} as the stack base`,
  );
  reporter.progress(`Using ${userLogin} as the remote branch namespace`);
  reporter.progress(`Fetching ${remote}/${base}`);

  const remoteBase = repository.fetchBase(remote, base);
  const baseOid = repository.mergeBase("HEAD", remoteBase);
  const commits = repository.commitsSince(baseOid);

  if (commits.length === 0) {
    throw new Error(`No commits found between ${base} and HEAD`);
  }

  reporter.progress(
    `Found ${commits.length} local change${commits.length === 1 ? "" : "s"}`,
  );

  const rewritten = commits.some((commit) => commit.changeId === undefined);
  if (rewritten) {
    reporter.progress(
      options.dryRun
        ? "Stable change IDs would be added to the commits"
        : "Adding stable change IDs to the commits",
    );
  } else {
    reporter.progress("All commits already have stable change IDs");
  }

  const changes = repository.ensureChangeIds(
    commits,
    options.dryRun,
    userLogin,
  );

  if (options.dryRun) {
    reporter.progress(
      "Dry run complete; no commits or remote branches were changed",
    );
    return { base, remote, rewritten, changes };
  }

  reporter.progress("Reading the previous stack state");

  const store = new StateStore(repository.statePath());
  const state = store.read();
  const previous = store.findByChangeIds(
    state,
    new Set(changes.map((change) => change.id)),
  );
  const transition = analyzeStackTransition(
    previous,
    changes,
    github,
    repository.currentBranch() === "",
  );

  reporter.progress(
    `Pushing ${changes.length} remote branch${changes.length === 1 ? "" : "es"}`,
  );
  repository.pushChanges(remote, changes);

  reporter.progress("Looking up existing pull requests");
  const existing = changes.map((change) =>
    github.pullRequestForBranch(change.remoteBranch),
  );
  let pullRequests: PullRequest[];
  if (changes.length === 1) {
    if (transition.kind === "partial") {
      reporter.progress(
        "Updating this down-stack prefix while preserving higher pull requests",
      );
    }
    reporter.progress(
      existing[0]
        ? "Using the existing pull request"
        : "Creating a pull request",
    );
    const pullRequest =
      existing[0] ?? github.createPullRequest(changes[0]!, base, options.draft);
    if (transition.kind === "collapse") {
      reporter.progress(
        `Removing omitted pull requests from stack #${transition.stackNumber}`,
      );
      github.unstack(transition.stackNumber);
      try {
        github.editPullRequestBase(pullRequest, base);
      } catch (error) {
        restorePreviousStack(github, previous!, base, remote, reporter, error);
      }
    }
    pullRequests = [pullRequest];
  } else {
    if (transition.kind === "full") {
      reporter.progress(
        `Linking ${changes.length} pull requests as a native GitHub stack`,
      );
      github.linkStack(
        changes.map((change) => change.remoteBranch),
        base,
        remote,
        options.draft,
      );
    } else if (transition.kind === "rebuild") {
      reporter.progress(
        `Rebuilding stack #${transition.stackNumber} to ${transition.action} pull requests`,
      );
      github.unstack(transition.stackNumber);
      try {
        github.linkStack(
          changes.map((change) => change.remoteBranch),
          base,
          remote,
          options.draft,
        );
      } catch (error) {
        restorePreviousStack(github, previous!, base, remote, reporter, error);
      }
    } else if (transition.kind === "append") {
      reporter.progress(
        `Appending ${transition.branches.length} pull request${transition.branches.length === 1 ? "" : "s"} to stack #${transition.stackNumber}`,
      );
      github.appendToStack(
        transition.stackNumber,
        transition.branches,
        remote,
        options.draft,
      );
    } else if (transition.kind === "partial") {
      reporter.progress(
        "Updating this down-stack prefix while preserving higher pull requests",
      );
    } else {
      reporter.progress(
        "The native GitHub stack already has the correct members",
      );
    }
    pullRequests = changes.map((change, index) => {
      const pr =
        existing[index] ?? github.pullRequestForBranch(change.remoteBranch);
      if (!pr) {
        throw new Error(
          `GitHub did not return a PR for ${change.remoteBranch}`,
        );
      }
      return pr;
    });
  }

  reporter.progress("Synchronizing pull request titles and descriptions");
  for (const [index, pr] of pullRequests.entries()) {
    github.editPullRequest(pr, changes[index]!);
    reporter.progress(`PR #${pr.number}: ${changes[index]!.subject}`);
  }

  const stackNumber =
    transition.kind === "rebuild"
      ? github.stackNumberForPullRequest(pullRequests[0]!.number)
      : transition.kind === "collapse"
        ? undefined
        : (previous?.stackNumber ??
          (pullRequests.length > 1
            ? github.stackNumberForPullRequest(pullRequests[0]!.number)
            : undefined));
  const synchronizedChanges = changes.map((change, index) => ({
    id: change.id,
    remoteBranch: change.remoteBranch,
    pullRequest: pullRequests[index]!.number,
    url: pullRequests[index]!.url,
  }));
  const storedChanges =
    transition.kind === "partial" && previous
      ? [
          ...synchronizedChanges,
          ...previous.changes.slice(transition.previousOffset + changes.length),
        ]
      : synchronizedChanges;
  const updatedStack: StoredStack = {
    remote,
    base,
    changes: storedChanges,
  };
  if (stackNumber !== undefined) {
    updatedStack.stackNumber = stackNumber;
  }
  writeUpdatedState(store, state, previous, updatedStack);
  reporter.progress("Saved the local stack state");

  return {
    base,
    remote,
    rewritten,
    changes: changes.map((change, index) => ({
      ...change,
      pullRequest: pullRequests[index]!,
    })),
  };
}

type StackTransition =
  | { kind: "full" }
  | {
      kind: "rebuild";
      stackNumber: number;
      action: "insert" | "remove" | "update";
    }
  | { kind: "collapse"; stackNumber: number }
  | { kind: "skip" }
  | { kind: "partial"; previousOffset: number }
  | { kind: "append"; stackNumber: number; branches: string[] };

function analyzeStackTransition(
  previous: StoredStack | undefined,
  changes: readonly StackChange[],
  github: GitHubPlatform,
  preserveHigherChanges: boolean,
): StackTransition {
  if (!previous) {
    return { kind: "full" };
  }
  const previousIds = previous.changes.map((change) => change.id);
  const currentIds = changes.map((change) => change.id);
  const previousIdSet = new Set(previousIds);
  const currentIdSet = new Set(currentIds);
  const sharedPrevious = previousIds.filter((id) => currentIdSet.has(id));
  const sharedCurrent = currentIds.filter((id) => previousIdSet.has(id));

  if (!sameSequence(sharedPrevious, sharedCurrent)) {
    throw new Error(
      "Submitted commits cannot be reordered. Restore their original relative order before syncing",
    );
  }

  const removed = previous.changes.filter(
    (change) => !currentIdSet.has(change.id),
  );
  const added = changes.filter((change) => !previousIdSet.has(change.id));

  if (removed.length === 0) {
    const onlyAppended = previousIds.every(
      (id, index) => currentIds[index] === id,
    );
    if (onlyAppended) {
      return { kind: "full" };
    }
    const stackNumber =
      previous.stackNumber ??
      github.stackNumberForPullRequest(previous.changes[0]!.pullRequest);
    return stackNumber === undefined
      ? { kind: "full" }
      : { kind: "rebuild", stackNumber, action: "insert" };
  }

  const firstCurrentIndex = previousIds.indexOf(currentIds[0]!);
  const isPreviousSlice =
    firstCurrentIndex >= 0 &&
    currentIds.every(
      (id, index) => previousIds[firstCurrentIndex + index] === id,
    );
  if (
    preserveHigherChanges &&
    added.length === 0 &&
    isPreviousSlice &&
    firstCurrentIndex + currentIds.length < previousIds.length
  ) {
    const removedPrefix = previous.changes.slice(0, firstCurrentIndex);
    const prefixWasMerged = removedPrefix.every(
      (change) => github.pullRequest(change.pullRequest).state === "MERGED",
    );
    if (prefixWasMerged) {
      return { kind: "partial", previousOffset: firstCurrentIndex };
    }
  }

  const removedIsPrefix = removed.every(
    (change, index) => previous.changes[index] === change,
  );
  const removedPrefixWasMerged =
    removedIsPrefix &&
    removed.every(
      (change) => github.pullRequest(change.pullRequest).state === "MERGED",
    );
  const survivingIds = previousIds.slice(removed.length);
  const onlyAppendedAfterMergedPrefix =
    removedPrefixWasMerged &&
    survivingIds.every((id, index) => currentIds[index] === id) &&
    currentIds.slice(survivingIds.length).every((id) => !previousIdSet.has(id));

  if (removedPrefixWasMerged && added.length === 0) {
    return { kind: "skip" };
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
    };
  }

  const stackNumber =
    previous.stackNumber ??
    github.stackNumberForPullRequest(previous.changes[0]!.pullRequest);
  if (stackNumber === undefined) {
    throw new Error(
      "Cannot remove submitted commits because the native GitHub stack number is missing from local state",
    );
  }
  if (changes.length === 1) {
    return { kind: "collapse", stackNumber };
  }
  return {
    kind: "rebuild",
    stackNumber,
    action: added.length === 0 ? "remove" : "update",
  };
}

function sameSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function restorePreviousStack(
  github: GitHubPlatform,
  previous: StoredStack,
  base: string,
  remote: string,
  reporter: Reporter,
  rebuildError: unknown,
): never {
  const rebuildMessage =
    rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
  reporter.progress(
    "Rebuild failed; restoring the previous native GitHub stack",
  );
  try {
    github.linkStack(
      previous.changes.map((change) => change.remoteBranch),
      base,
      remote,
      true,
    );
  } catch (rollbackError) {
    const rollbackMessage =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    throw new Error(
      `Stack rebuild failed: ${rebuildMessage}\nRestoring the previous stack also failed: ${rollbackMessage}`,
    );
  }
  throw rebuildError;
}

function writeUpdatedState(
  store: StateStore,
  state: RepositoryState,
  previous: StoredStack | undefined,
  updated: StoredStack,
): void {
  const stacks = previous
    ? state.stacks.map((stack) => (stack === previous ? updated : stack))
    : [...state.stacks, updated];
  store.write({ schemaVersion: 1, stacks });
}
