import type { GitRepository, PushResult } from "../git";
import type { GitHubPlatform } from "../github";
import type {
  PullRequest,
  RepositoryState,
  StackChange,
  StoredChange,
  StoredStackEntry,
  StoredStack,
} from "../model";
import type { Reporter } from "../reporter";
import { Stack, type StackTransition } from "../stack";
import type { StateStore } from "../state";

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

type PreparedStack = {
  base: string;
  remote: string;
  stack: Stack;
};

type MatchedChange = {
  change: StackChange;
  pullRequest: PullRequest;
  created: boolean;
};

type SynchronizedChange = StackChange & { pullRequest: PullRequest };

type OutcomeContext = {
  previous: StoredStack | undefined;
  base: string;
  pushedBranches: ReadonlySet<string>;
};

export class SyncCommand {
  constructor(
    private readonly repository: GitRepository,
    private readonly github: GitHubPlatform,
    private readonly reporter: Reporter,
    private readonly stateStore: StateStore,
  ) {}

  run(options: SyncOptions): SyncResult {
    const { base, remote, stack } = this.prepareStack(options);
    const { changes, rewritten } = stack;

    if (options.dryRun) {
      this.reporter.progress(
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

    return this.synchronize(stack, options, base, remote);
  }

  private prepareStack(options: SyncOptions): PreparedStack {
    this.reporter.progress("Checking the repository and GitHub prerequisites");
    this.repository.assertReady();
    this.github.assertReady();

    const remote = this.repository.resolveRemote(options.remote);
    const base = options.base ?? this.github.defaultBranch();
    const userLogin = this.github.currentUserLogin();

    this.reporter.progress(
      `Using ${remote} as the remote and ${base} as the stack base`,
    );
    this.reporter.progress(`Using ${userLogin} as the remote branch namespace`);
    this.reporter.progress(`Fetching ${remote}/${base}`);

    const remoteBase = this.repository.fetchBase(remote, base);
    const baseOid = this.repository.mergeBase("HEAD", remoteBase);
    const commits = this.repository.commitsSince(baseOid);

    if (commits.length === 0) {
      throw new Error(`No commits found between ${base} and HEAD`);
    }

    this.reporter.progress(
      `Found ${commits.length} local change${commits.length === 1 ? "" : "s"}`,
    );

    const pendingStack = Stack.fromCommits(commits, userLogin);

    if (pendingStack.rewritten) {
      this.reporter.progress(
        options.dryRun
          ? "Stable change IDs would be added to the commits"
          : "Adding stable change IDs to the commits",
      );
    } else {
      this.reporter.progress("All commits already have stable change IDs");
    }

    let stack = pendingStack;

    if (!options.dryRun && pendingStack.rewritten) {
      const rewrittenOids = this.repository.rewriteCommits(
        pendingStack.commitRewrites,
      );

      stack = pendingStack.withRewrittenOids(rewrittenOids);
    }

    return {
      base,
      remote,
      stack,
    };
  }

  private synchronize(
    stack: Stack,
    options: SyncOptions,
    base: string,
    remote: string,
  ): SyncResult {
    const { changes, rewritten } = stack;

    this.reporter.progress("Reading the previous stack state");

    const state = this.stateStore.read();
    const previousEntry = stack.findPrevious(state);

    const transition = stack.transitionFrom(previousEntry?.stack, {
      base,
      preserveHigherChanges: this.repository.currentBranch() === undefined,
      lookups: {
        pullRequestState: (pullRequest) =>
          this.github.pullRequest(pullRequest).state,
        stackNumberForPullRequest: (pullRequest) =>
          this.github.stackNumberForPullRequest(pullRequest),
      },
    });

    this.prepareTransition(transition, base);
    const pushedBranches = this.pushBranches(remote, changes, transition);
    const matchedChanges = this.matchPullRequests(changes, base, options.draft);

    this.applyTransition(
      transition,
      matchedChanges,
      base,
      remote,
      options.draft,
    );

    const omittedPullRequests = this.closeOmittedPullRequests(
      transition,
      changes,
    );

    this.updatePullRequestMetadata(matchedChanges);
    this.saveStack(
      state,
      previousEntry,
      transition,
      matchedChanges,
      base,
      remote,
    );

    const synchronized = synchronizeChanges(matchedChanges);

    const outcomes = buildOutcomes(matchedChanges, omittedPullRequests, {
      previous: transition.previous,
      base,
      pushedBranches,
    });

    return {
      base,
      remote,
      rewritten,
      changes: synchronized,
      outcomes,
    };
  }

  private pushBranches(
    remote: string,
    changes: readonly StackChange[],
    transition: StackTransition,
  ): ReadonlySet<string> {
    try {
      const pushResult = this.repository.pushBranches(
        remote,
        changes.map((change) => ({
          name: change.remoteBranch,
          oid: change.oid,
        })),
      );

      reportPushResult(this.reporter, pushResult);

      return new Set(pushResult.updated);
    } catch (error) {
      if (isReorder(transition)) {
        this.restorePreviousStack(transition.previous, error);
      }

      throw error;
    }
  }

  private matchPullRequests(
    changes: readonly StackChange[],
    base: string,
    draft: boolean,
  ): MatchedChange[] {
    this.reporter.progress("Looking up existing pull requests");

    const candidates = changes.map((change) => ({
      change,
      current: this.github.pullRequestForBranch(change.remoteBranch),
    }));

    const matchedChanges: MatchedChange[] = [];

    for (const { change, current } of candidates) {
      const pullRequestBase =
        matchedChanges.at(-1)?.change.remoteBranch ?? base;

      if (!current) {
        this.reporter.progress(`Creating pull request: ${change.subject}`);
      }

      const pullRequest =
        current ??
        this.github.createPullRequest(change, pullRequestBase, draft);

      matchedChanges.push({
        change,
        pullRequest,
        created: current === undefined,
      });
    }

    return matchedChanges;
  }

  private closeOmittedPullRequests(
    transition: StackTransition,
    changes: readonly StackChange[],
  ): PullRequest[] {
    const omittedPullRequests = this.omittedPullRequests(transition, changes);

    if (omittedPullRequests.length === 0) {
      return omittedPullRequests;
    }

    this.reporter.progress(
      `Closing ${omittedPullRequests.length} omitted pull request${omittedPullRequests.length === 1 ? "" : "s"}`,
    );

    for (const pullRequest of omittedPullRequests) {
      this.github.closePullRequest(pullRequest);
    }

    return omittedPullRequests;
  }

  private omittedPullRequests(
    transition: StackTransition,
    changes: readonly StackChange[],
  ): PullRequest[] {
    if (transition.kind === "partial") {
      return [];
    }

    const currentIds = new Set(changes.map((change) => change.id));

    return (transition.previous?.changes ?? [])
      .filter((change) => !currentIds.has(change.id))
      .map((change) => this.github.pullRequest(change.pullRequest))
      .filter((pullRequest) => pullRequest.state === "OPEN");
  }

  private updatePullRequestMetadata(matchedChanges: readonly MatchedChange[]) {
    this.reporter.progress(
      "Synchronizing pull request titles and descriptions",
    );

    for (const { change, pullRequest } of matchedChanges) {
      this.github.editPullRequest(pullRequest, change);
      this.reporter.progress(`PR #${pullRequest.number}: ${change.subject}`);
    }
  }

  private saveStack(
    state: RepositoryState,
    previousEntry: StoredStackEntry | undefined,
    transition: StackTransition,
    matchedChanges: readonly MatchedChange[],
    base: string,
    remote: string,
  ) {
    const synchronizedChanges = matchedChanges.map(
      ({ change, pullRequest }) => ({
        id: change.id,
        remoteBranch: change.remoteBranch,
        pullRequest: pullRequest.number,
        url: pullRequest.url,
      }),
    );

    const storedChanges = changesForState(synchronizedChanges, transition);

    const updatedStack: StoredStack = {
      remote,
      base,
      changes: storedChanges,
    };

    const stackNumber = this.updatedStackNumber(transition, matchedChanges);

    if (stackNumber !== undefined) {
      updatedStack.stackNumber = stackNumber;
    }

    writeUpdatedState(this.stateStore, state, previousEntry, updatedStack);

    this.reporter.progress("Saved the local stack state");
  }

  private updatedStackNumber(
    transition: StackTransition,
    matchedChanges: readonly MatchedChange[],
  ): number | undefined {
    const firstPullRequest = firstMatchedChange(matchedChanges).pullRequest;

    if (transition.kind === "rebuild") {
      return this.github.stackNumberForPullRequest(firstPullRequest.number);
    }

    if (transition.kind === "collapse") {
      return undefined;
    }

    if (transition.previous?.stackNumber !== undefined) {
      return transition.previous.stackNumber;
    }

    if (matchedChanges.length > 1) {
      return this.github.stackNumberForPullRequest(firstPullRequest.number);
    }

    return undefined;
  }

  private prepareTransition(transition: StackTransition, base: string) {
    if (transition.kind !== "rebuild" || transition.action !== "reorder") {
      return;
    }

    this.reporter.progress(
      `Preparing stack #${transition.stackNumber} for reordered branches`,
    );
    this.github.unstack(transition.stackNumber);

    try {
      for (const change of transition.previous.changes) {
        const pullRequest = this.github.pullRequest(change.pullRequest);

        if (pullRequest.state === "OPEN") {
          this.github.editPullRequestBase(pullRequest, base);
        }
      }
    } catch (error) {
      this.restorePreviousStack(transition.previous, error);
    }
  }

  private applyTransition(
    transition: StackTransition,
    matchedChanges: readonly MatchedChange[],
    base: string,
    remote: string,
    draft: boolean,
  ) {
    const firstMatch = firstMatchedChange(matchedChanges);

    if (transition.kind === "retarget") {
      this.reporter.progress(`Updating the pull request base to ${base}`);
      this.github.editPullRequestBase(firstMatch.pullRequest, base);

      return;
    }

    if (matchedChanges.length === 1) {
      this.applySingleChangeTransition(
        transition,
        firstMatch.pullRequest,
        base,
      );

      return;
    }

    switch (transition.kind) {
      case "full":
        this.linkFullStack(matchedChanges, base, remote, draft);
        break;
      case "rebuild":
        this.rebuildStack(transition, matchedChanges, base, remote, draft);
        break;
      case "append":
        this.appendToStack(transition, matchedChanges, remote, draft);
        break;
      case "partial":
        this.reportPartialUpdate();
        break;
      default:
        this.reporter.progress(
          "The native GitHub stack already has the correct members",
        );
    }
  }

  private applySingleChangeTransition(
    transition: StackTransition,
    pullRequest: PullRequest,
    base: string,
  ) {
    if (transition.kind === "partial") {
      this.reportPartialUpdate();

      return;
    }

    if (transition.kind !== "collapse") {
      return;
    }

    this.reporter.progress(
      `Removing omitted pull requests from stack #${transition.stackNumber}`,
    );
    this.github.unstack(transition.stackNumber);

    try {
      this.github.editPullRequestBase(pullRequest, base);
    } catch (error) {
      this.restorePreviousStack(transition.previous, error);
    }
  }

  private linkFullStack(
    matchedChanges: readonly MatchedChange[],
    base: string,
    remote: string,
    draft: boolean,
  ) {
    this.reporter.progress(
      `Linking ${matchedChanges.length} pull requests as a native GitHub stack`,
    );

    this.github.linkStack(
      matchedChanges.map(({ pullRequest }) => pullRequest.number),
      base,
      remote,
      draft,
    );
  }

  private rebuildStack(
    transition: Extract<StackTransition, { kind: "rebuild" }>,
    matchedChanges: readonly MatchedChange[],
    base: string,
    remote: string,
    draft: boolean,
  ) {
    const reason =
      transition.action === "change-base"
        ? `against ${base}`
        : `to ${transition.action} pull requests`;

    this.reporter.progress(
      `Rebuilding stack #${transition.stackNumber} ${reason}`,
    );

    if (transition.action !== "reorder") {
      this.github.unstack(transition.stackNumber);
    }

    try {
      this.github.linkStack(
        matchedChanges.map(({ pullRequest }) => pullRequest.number),
        base,
        remote,
        draft,
      );
    } catch (error) {
      this.restorePreviousStack(transition.previous, error);
    }
  }

  private appendToStack(
    transition: Extract<StackTransition, { kind: "append" }>,
    matchedChanges: readonly MatchedChange[],
    remote: string,
    draft: boolean,
  ) {
    this.reporter.progress(
      `Appending ${transition.branches.length} pull request${transition.branches.length === 1 ? "" : "s"} to stack #${transition.stackNumber}`,
    );

    this.github.appendToStack(
      transition.stackNumber,
      transition.branches.map((branch) =>
        pullRequestNumberForBranch(branch, matchedChanges),
      ),
      remote,
      draft,
    );
  }

  private reportPartialUpdate() {
    this.reporter.progress(
      "Updating this down-stack prefix while preserving higher pull requests",
    );
  }

  private restorePreviousStack(previous: StoredStack, cause: unknown): never {
    const rebuildMessage =
      cause instanceof Error ? cause.message : String(cause);

    this.reporter.progress(
      "Rebuild failed; restoring the previous native GitHub stack",
    );

    try {
      const pullRequests = previous.changes
        .map((change) => this.github.pullRequest(change.pullRequest))
        .filter((pullRequest) => pullRequest.state === "OPEN");

      const firstPullRequest = pullRequests[0];

      if (pullRequests.length === 1 && firstPullRequest) {
        this.github.editPullRequestBase(firstPullRequest, previous.base);
      } else if (pullRequests.length > 1) {
        this.github.linkStack(
          pullRequests.map((pullRequest) => pullRequest.number),
          previous.base,
          previous.remote,
          true,
        );
      }
    } catch (rollbackError) {
      const rollbackMessage =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);

      throw new Error(
        `Stack rebuild failed: ${rebuildMessage}\nRestoring the previous stack also failed: ${rollbackMessage}`,
        { cause: rollbackError },
      );
    }

    throw cause;
  }
}

function isReorder(transition: StackTransition): transition is Extract<
  StackTransition,
  { kind: "rebuild" }
> & {
  action: "reorder";
} {
  return transition.kind === "rebuild" && transition.action === "reorder";
}

function pullRequestNumberForBranch(
  branch: string,
  matchedChanges: readonly MatchedChange[],
): number {
  const match = matchedChanges.find(
    ({ change }) => change.remoteBranch === branch,
  );

  if (!match) {
    throw new Error(`Missing pull request for ${branch}`);
  }

  return match.pullRequest.number;
}

function changesForState(
  synchronized: StoredChange[],
  transition: StackTransition,
): StoredChange[] {
  if (transition.kind !== "partial") {
    return synchronized;
  }

  const preserved = transition.previous.changes.slice(
    transition.previousOffset + synchronized.length,
  );

  return [...synchronized, ...preserved];
}

function synchronizeChanges(
  matchedChanges: readonly MatchedChange[],
): SynchronizedChange[] {
  return matchedChanges.map(({ change, pullRequest }) => ({
    ...change,
    pullRequest,
  }));
}

function firstMatchedChange(
  matchedChanges: readonly MatchedChange[],
): MatchedChange {
  const first = matchedChanges[0];

  if (!first) {
    throw new Error("A synchronized stack must contain at least one change");
  }

  return first;
}

function buildOutcomes(
  matchedChanges: readonly MatchedChange[],
  omittedPullRequests: readonly PullRequest[],
  context: OutcomeContext,
): SyncOutcome[] {
  const synchronizedOutcomes = matchedChanges.map(
    (match, index): SyncOutcome => ({
      outcome: changeOutcome(match, index, matchedChanges, context),
      change: match.change,
      pullRequest: match.pullRequest,
    }),
  );

  const closedOutcomes = omittedPullRequests.map(
    (pullRequest): SyncOutcome => ({
      outcome: "closed",
      pullRequest,
    }),
  );

  return [...synchronizedOutcomes, ...closedOutcomes];
}

function changeOutcome(
  match: MatchedChange,
  index: number,
  matchedChanges: readonly MatchedChange[],
  context: OutcomeContext,
): "created" | "updated" | "unchanged" {
  if (match.created) {
    return "created";
  }

  const { change, pullRequest } = match;
  const previousBase = previousBaseFor(change, context.previous);

  const currentBase =
    matchedChanges[index - 1]?.change.remoteBranch ?? context.base;

  const metadataChanged =
    pullRequest.title !== change.subject || pullRequest.body !== change.body;

  const updated =
    context.pushedBranches.has(change.remoteBranch) ||
    previousBase !== currentBase ||
    metadataChanged;

  return updated ? "updated" : "unchanged";
}

function previousBaseFor(
  change: StackChange,
  previous: StoredStack | undefined,
): string | undefined {
  if (!previous) {
    return undefined;
  }

  const previousIndex = previous.changes.findIndex(
    (candidate) => candidate.id === change.id,
  );

  if (previousIndex < 0) {
    return undefined;
  }

  if (previousIndex === 0) {
    return previous.base;
  }

  return previous.changes[previousIndex - 1]!.remoteBranch;
}

function reportPushResult(reporter: Reporter, result: PushResult) {
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
  previous: StoredStackEntry | undefined,
  updated: StoredStack,
) {
  const stacks = [...state.stacks];

  if (previous) {
    stacks[previous.index] = updated;
  } else {
    stacks.push(updated);
  }

  store.write({
    schemaVersion: 1,
    stacks,
  });
}

export function formatSyncResult(result: SyncResult, dryRun: boolean): string {
  const changeCount = `${result.changes.length} change${result.changes.length === 1 ? "" : "s"}`;

  const lines = [
    dryRun
      ? `Would sync ${changeCount} against ${result.base}:`
      : `Synced ${result.changes.length}-commit stack against ${result.base}:`,
  ];

  if (dryRun) {
    for (const change of result.changes) {
      lines.push(`  ${change.oid.slice(0, 8)}  ${change.subject}`);
    }

    return lines.join("\n");
  }

  for (const outcome of result.outcomes) {
    if (outcome.outcome === "closed") {
      const { pullRequest } = outcome;

      lines.push(
        `  ${outcome.outcome.padEnd(9)} #${pullRequest.number}  ${pullRequest.title} ${pullRequest.url}`,
      );

      continue;
    }

    lines.push(
      `  ${outcome.outcome.padEnd(9)} #${outcome.pullRequest.number}  ${outcome.change.subject} ${outcome.pullRequest.url}`,
    );
  }

  return lines.join("\n");
}
