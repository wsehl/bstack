import type { GitRepository } from "./git";
import type { GitHubPlatform } from "./github";
import type { BstackState, Change, PullRequest, StoredStack } from "./model";
import type { Reporter } from "./reporter";
import { StateStore } from "./state";

export type SyncOptions = {
  base: string | undefined;
  remote: string | undefined;
  open: boolean;
  dryRun: boolean;
  reporter: Reporter;
};

export type SyncResult = {
  base: string;
  remote: string;
  rewritten: boolean;
  changes: Array<Change & { pullRequest?: PullRequest }>;
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
  reporter.progress(
    `Using ${remote} as the remote and ${base} as the stack base`,
  );
  reporter.progress(`Fetching ${remote}/${base}`);
  const remoteBase = repository.fetchBase(remote, base);
  const baseOid = repository.mergeBase("HEAD", remoteBase);
  const commits = repository.commitsSince(baseOid);
  if (commits.length === 0)
    throw new Error(`No commits found between ${base} and HEAD`);
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
  const changes = repository.ensureChangeIds(commits, options.dryRun);
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
  const evolution = analyzeEvolution(previous, changes, github);

  reporter.progress(
    `Publishing ${changes.length} protected remote ref${changes.length === 1 ? "" : "s"}`,
  );
  repository.pushChanges(remote, changes);

  reporter.progress("Looking up existing pull requests");
  const existing = changes.map((change) =>
    github.pullRequestForBranch(change.remoteBranch),
  );
  let pullRequests: PullRequest[];
  if (changes.length === 1) {
    if (evolution.kind === "partial") {
      reporter.progress(
        "Updating this down-stack prefix while preserving higher pull requests",
      );
    }
    reporter.progress(
      existing[0]
        ? "Using the existing pull request"
        : "Creating a pull request",
    );
    pullRequests = [
      existing[0] ?? github.createPullRequest(changes[0]!, base, options.open),
    ];
  } else {
    if (evolution.kind === "full") {
      reporter.progress(
        `Linking ${changes.length} pull requests as a native GitHub stack`,
      );
      github.linkStack(
        changes.map((change) => change.remoteBranch),
        base,
        remote,
        options.open,
      );
    } else if (evolution.kind === "append") {
      reporter.progress(
        `Appending ${evolution.branches.length} pull request${evolution.branches.length === 1 ? "" : "s"} to stack #${evolution.stackNumber}`,
      );
      github.appendToStack(
        evolution.stackNumber,
        evolution.branches,
        remote,
        options.open,
      );
    } else if (evolution.kind === "partial") {
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
      if (!pr)
        throw new Error(
          `GitHub did not return a PR for ${change.remoteBranch}`,
        );
      return pr;
    });
  }

  reporter.progress("Synchronizing pull request titles and descriptions");
  for (const [index, pr] of pullRequests.entries()) {
    github.editPullRequest(pr, changes[index]!);
    reporter.progress(`PR #${pr.number}: ${changes[index]!.subject}`);
  }

  const stackNumber =
    previous?.stackNumber ??
    (pullRequests.length > 1
      ? github.stackNumberForPullRequest(pullRequests[0]!.number)
      : undefined);
  const synchronizedChanges = changes.map((change, index) => ({
    id: change.id,
    remoteBranch: change.remoteBranch,
    pullRequest: pullRequests[index]!.number,
    url: pullRequests[index]!.url,
  }));
  const storedChanges =
    evolution.kind === "partial" && previous
      ? [
          ...synchronizedChanges,
          ...previous.changes.slice(evolution.previousOffset + changes.length),
        ]
      : synchronizedChanges;
  const stored: StoredStack = {
    remote,
    base,
    ...(stackNumber === undefined ? {} : { stackNumber }),
    changes: storedChanges,
  };
  writeUpdatedState(store, state, previous, stored);
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

type Evolution =
  | { kind: "full" }
  | { kind: "skip" }
  | { kind: "partial"; previousOffset: number }
  | { kind: "append"; stackNumber: number; branches: string[] };

function analyzeEvolution(
  previous: StoredStack | undefined,
  changes: readonly Change[],
  github: GitHubPlatform,
): Evolution {
  if (!previous) return { kind: "full" };
  const previousIds = previous.changes.map((change) => change.id);
  const currentIds = changes.map((change) => change.id);

  const firstCurrentIndex = previousIds.indexOf(currentIds[0]!);
  if (firstCurrentIndex === -1) {
    throw new Error(
      "The current commits do not continue the previously submitted stack",
    );
  }

  const removedPrefix = previous.changes.slice(0, firstCurrentIndex);
  for (const removed of removedPrefix) {
    if (github.pullRequest(removed.pullRequest).state !== "MERGED") {
      throw new Error(
        "Submitted commits may only disappear from the bottom after their pull requests are merged",
      );
    }
  }

  const surviving = previousIds.slice(firstCurrentIndex);
  const sharedLength = Math.min(surviving.length, currentIds.length);
  for (let index = 0; index < sharedLength; index++) {
    if (surviving[index] !== currentIds[index]) {
      throw new Error(
        "Reordering or removing submitted commits is not supported yet. Restore the original order before syncing",
      );
    }
  }
  if (currentIds.length < surviving.length) {
    return { kind: "partial", previousOffset: firstCurrentIndex };
  }

  const appended = changes.slice(surviving.length);
  if (removedPrefix.length === 0) return { kind: "full" };
  if (appended.length === 0) return { kind: "skip" };
  if (previous.stackNumber === undefined) {
    throw new Error(
      "Cannot append after a merge because the native GitHub stack number is missing from local state",
    );
  }
  return {
    kind: "append",
    stackNumber: previous.stackNumber,
    branches: appended.map((change) => change.remoteBranch),
  };
}

function writeUpdatedState(
  store: StateStore,
  state: BstackState,
  previous: StoredStack | undefined,
  updated: StoredStack,
): void {
  const stacks = previous
    ? state.stacks.map((stack) => (stack === previous ? updated : stack))
    : [...state.stacks, updated];
  store.write({ schemaVersion: 1, stacks });
}
