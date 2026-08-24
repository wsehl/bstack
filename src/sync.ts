import type { GitRepository } from "./git";
import type { GitHubPlatform } from "./github";
import type {
  PullRequest,
  RepositoryState,
  StackChange,
  StoredStack,
} from "./model";
import type { Reporter } from "./reporter";
import { Stack } from "./stack";
import type { StateStore } from "./state";

export type SyncDependencies = {
  repository: GitRepository;
  github: GitHubPlatform;
  stateStore: StateStore;
  reporter: Reporter;
};

export type SyncOptions = {
  base: string | undefined;
  remote: string | undefined;
  draft: boolean;
  dryRun: boolean;
};

export type SyncResult = {
  base: string;
  remote: string;
  rewritten: boolean;
  changes: Array<StackChange & { pullRequest?: PullRequest }>;
};

export function syncStack(
  dependencies: SyncDependencies,
  options: SyncOptions,
): SyncResult {
  const { repository, github, stateStore, reporter } = dependencies;

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

  const pendingStack = Stack.fromCommits(commits, userLogin);
  if (pendingStack.rewritten) {
    reporter.progress(
      options.dryRun
        ? "Stable change IDs would be added to the commits"
        : "Adding stable change IDs to the commits",
    );
  } else {
    reporter.progress("All commits already have stable change IDs");
  }

  const stack = options.dryRun
    ? pendingStack
    : pendingStack.writeChangeIds(repository);
  const { changes, rewritten } = stack;

  if (options.dryRun) {
    reporter.progress(
      "Dry run complete; no commits or remote branches were changed",
    );
    return { base, remote, rewritten, changes: [...changes] };
  }

  reporter.progress("Reading the previous stack state");

  const state = stateStore.read();
  const previous = stack.findPrevious(state);
  const transition = stack.transitionFrom(previous, {
    preserveHigherChanges: repository.currentBranch() === undefined,
    lookups: {
      pullRequestState: (pullRequest) => github.pullRequest(pullRequest).state,
      stackNumberForPullRequest: (pullRequest) =>
        github.stackNumberForPullRequest(pullRequest),
    },
  });

  const isReorder =
    transition.kind === "rebuild" && transition.action === "reorder";
  if (isReorder) {
    reporter.progress(
      `Preparing stack #${transition.stackNumber} for reordered branches`,
    );
    github.unstack(transition.stackNumber);
    try {
      for (const change of previous!.changes) {
        github.editPullRequestBase(
          github.pullRequest(change.pullRequest),
          base,
        );
      }
    } catch (error) {
      restorePreviousStack(github, previous!, base, remote, reporter, error);
    }
  }

  reporter.progress(
    `Pushing ${changes.length} remote branch${changes.length === 1 ? "" : "es"}`,
  );
  try {
    repository.pushBranches(
      remote,
      changes.map((change) => ({
        name: change.remoteBranch,
        oid: change.oid,
      })),
    );
  } catch (error) {
    if (isReorder) {
      restorePreviousStack(github, previous!, base, remote, reporter, error);
    }
    throw error;
  }

  reporter.progress("Looking up existing pull requests");
  const existing = changes.map((change) =>
    github.pullRequestForBranch(change.remoteBranch),
  );
  const pullRequests = changes.map((change, index) => {
    const current = existing[index];
    if (current) {
      return current;
    }

    const pullRequestBase =
      index === 0 ? base : changes[index - 1]!.remoteBranch;
    reporter.progress(`Creating pull request: ${change.subject}`);

    return github.createPullRequest(change, pullRequestBase, options.draft);
  });

  if (changes.length === 1) {
    if (transition.kind === "partial") {
      reporter.progress(
        "Updating this down-stack prefix while preserving higher pull requests",
      );
    }
    const pullRequest = pullRequests[0]!;
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
  } else {
    if (transition.kind === "full") {
      reporter.progress(
        `Linking ${changes.length} pull requests as a native GitHub stack`,
      );
      github.linkStack(
        pullRequests.map((pullRequest) => pullRequest.number),
        base,
        remote,
        options.draft,
      );
    } else if (transition.kind === "rebuild") {
      reporter.progress(
        `Rebuilding stack #${transition.stackNumber} to ${transition.action} pull requests`,
      );
      if (!isReorder) {
        github.unstack(transition.stackNumber);
      }
      try {
        github.linkStack(
          pullRequests.map((pullRequest) => pullRequest.number),
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
        transition.branches.map((branch) => {
          const index = changes.findIndex(
            (change) => change.remoteBranch === branch,
          );
          const pullRequest = pullRequests[index];
          if (!pullRequest) {
            throw new Error(`Missing pull request for ${branch}`);
          }

          return pullRequest.number;
        }),
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
  writeUpdatedState(stateStore, state, previous, updatedStack);
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
      previous.changes.map((change) => change.pullRequest),
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
