import type { GitRepository, PushResult } from "./git";
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
import {
  applyStackTransition,
  prepareStackTransition,
  restorePreviousStack,
} from "./sync-transition";

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
  outcomes: SyncOutcome[];
};

export type SyncOutcome =
  | {
      outcome: "created" | "updated" | "unchanged";
      change: StackChange;
      pullRequest: PullRequest;
    }
  | {
      outcome: "closed";
      pullRequest: PullRequest;
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
    return {
      base,
      remote,
      rewritten,
      changes: [...changes],
      outcomes: [],
    };
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

  prepareStackTransition(transition, github, previous, base, remote, reporter);
  const isReorder =
    transition.kind === "rebuild" && transition.action === "reorder";
  let pushedBranches = new Set<string>();
  try {
    const pushResult = repository.pushBranches(
      remote,
      changes.map((change) => ({
        name: change.remoteBranch,
        oid: change.oid,
      })),
    );
    reportPushResult(reporter, pushResult);
    pushedBranches = new Set(pushResult.updated);
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
  const createdBranches = new Set(
    changes
      .filter((_change, index) => existing[index] === undefined)
      .map((change) => change.remoteBranch),
  );

  applyStackTransition(
    transition,
    github,
    previous,
    changes,
    pullRequests,
    base,
    remote,
    options.draft,
    reporter,
  );

  const currentIds = new Set(changes.map((change) => change.id));
  const omittedPullRequests =
    transition.kind === "partial"
      ? []
      : (previous?.changes ?? [])
          .filter((change) => !currentIds.has(change.id))
          .map((change) => github.pullRequest(change.pullRequest))
          .filter((pullRequest) => pullRequest.state === "OPEN");
  if (omittedPullRequests.length > 0) {
    reporter.progress(
      `Closing ${omittedPullRequests.length} omitted pull request${omittedPullRequests.length === 1 ? "" : "s"}`,
    );
    for (const pullRequest of omittedPullRequests) {
      github.closePullRequest(pullRequest);
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

  const synchronized = changes.map((change, index) => ({
    ...change,
    pullRequest: pullRequests[index]!,
  }));
  const outcomes: SyncOutcome[] = synchronized.map((change, index) => ({
    outcome: changeOutcome(
      change,
      index,
      change.pullRequest,
      previous,
      changes,
      base,
      createdBranches,
      pushedBranches,
    ),
    change,
    pullRequest: change.pullRequest,
  }));
  outcomes.push(
    ...omittedPullRequests.map((pullRequest): SyncOutcome => ({
      outcome: "closed",
      pullRequest,
    })),
  );

  return {
    base,
    remote,
    rewritten,
    changes: synchronized,
    outcomes,
  };
}

function changeOutcome(
  change: StackChange,
  index: number,
  pullRequest: PullRequest,
  previous: StoredStack | undefined,
  changes: readonly StackChange[],
  base: string,
  createdBranches: ReadonlySet<string>,
  pushedBranches: ReadonlySet<string>,
): "created" | "updated" | "unchanged" {
  if (createdBranches.has(change.remoteBranch)) {
    return "created";
  }

  const previousIndex = previous?.changes.findIndex(
    (candidate) => candidate.id === change.id,
  );
  const previousBase =
    previousIndex === undefined || previousIndex < 0
      ? undefined
      : previousIndex === 0
        ? previous!.base
        : previous!.changes[previousIndex - 1]!.remoteBranch;
  const currentBase = index === 0 ? base : changes[index - 1]!.remoteBranch;
  const metadataChanged =
    pullRequest.title !== change.subject || pullRequest.body !== change.body;
  const updated =
    pushedBranches.has(change.remoteBranch) ||
    previousBase !== currentBase ||
    metadataChanged;

  return updated ? "updated" : "unchanged";
}

function reportPushResult(reporter: Reporter, result: PushResult): void {
  if (result.updated.length === 0) {
    reporter.progress(
      `All ${result.checked} remote branch${result.checked === 1 ? "" : "es"} already match`,
    );

    return;
  }

  reporter.progress(
    `Updating ${result.updated.length} of ${result.checked} remote branch${result.checked === 1 ? "" : "es"}`,
  );
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
