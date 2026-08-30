import type { GitRepository, PushResult } from "../git";
import type { GitHubPlatform } from "../github";
import type {
  PullRequest,
  RepositoryState,
  StackChange,
  StoredChange,
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

type PullRequestMatch = {
  pullRequests: PullRequest[];
  createdBranches: ReadonlySet<string>;
};

type SynchronizedChange = StackChange & { pullRequest: PullRequest };

type OutcomeContext = {
  previous: StoredStack | undefined;
  changes: readonly StackChange[];
  base: string;
  createdBranches: ReadonlySet<string>;
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
    const previous = stack.findPrevious(state);
    const transition = stack.transitionFrom(previous, {
      base,
      preserveHigherChanges: this.repository.currentBranch() === undefined,
      lookups: {
        pullRequestState: (pullRequest) =>
          this.github.pullRequest(pullRequest).state,
        stackNumberForPullRequest: (pullRequest) =>
          this.github.stackNumberForPullRequest(pullRequest),
      },
    });

    this.prepareTransition(transition, previous, base);
    const pushedBranches = this.pushBranches(
      remote,
      changes,
      transition,
      previous,
    );
    const { pullRequests, createdBranches } = this.matchPullRequests(
      changes,
      base,
      options.draft,
    );

    this.applyTransition(
      transition,
      previous,
      changes,
      pullRequests,
      base,
      remote,
      options.draft,
    );

    const omittedPullRequests = this.closeOmittedPullRequests(
      transition,
      previous,
      changes,
    );
    this.updatePullRequestMetadata(changes, pullRequests);
    this.saveStack(
      state,
      previous,
      transition,
      changes,
      pullRequests,
      base,
      remote,
    );

    const synchronized = synchronizeChanges(changes, pullRequests);
    const outcomes = buildOutcomes(synchronized, omittedPullRequests, {
      previous,
      changes,
      base,
      createdBranches,
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
    previous: StoredStack | undefined,
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
        this.restorePreviousStack(previous!, error);
      }

      throw error;
    }
  }

  private matchPullRequests(
    changes: readonly StackChange[],
    base: string,
    draft: boolean,
  ): PullRequestMatch {
    this.reporter.progress("Looking up existing pull requests");

    const existing = changes.map((change) =>
      this.github.pullRequestForBranch(change.remoteBranch),
    );

    const pullRequests = changes.map((change, index) => {
      const current = existing[index];

      if (current) {
        return current;
      }

      const pullRequestBase = pullRequestBaseFor(changes, index, base);
      this.reporter.progress(`Creating pull request: ${change.subject}`);

      return this.github.createPullRequest(change, pullRequestBase, draft);
    });

    const createdBranches = changes
      .filter((_change, index) => existing[index] === undefined)
      .map((change) => change.remoteBranch);

    return {
      pullRequests,
      createdBranches: new Set(createdBranches),
    };
  }

  private closeOmittedPullRequests(
    transition: StackTransition,
    previous: StoredStack | undefined,
    changes: readonly StackChange[],
  ): PullRequest[] {
    const omittedPullRequests = this.omittedPullRequests(
      transition,
      previous,
      changes,
    );

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
    previous: StoredStack | undefined,
    changes: readonly StackChange[],
  ): PullRequest[] {
    if (transition.kind === "partial") {
      return [];
    }

    const currentIds = new Set(changes.map((change) => change.id));

    return (previous?.changes ?? [])
      .filter((change) => !currentIds.has(change.id))
      .map((change) => this.github.pullRequest(change.pullRequest))
      .filter((pullRequest) => pullRequest.state === "OPEN");
  }

  private updatePullRequestMetadata(
    changes: readonly StackChange[],
    pullRequests: readonly PullRequest[],
  ): void {
    this.reporter.progress(
      "Synchronizing pull request titles and descriptions",
    );

    for (const [index, pullRequest] of pullRequests.entries()) {
      const change = changes[index]!;
      this.github.editPullRequest(pullRequest, change);
      this.reporter.progress(`PR #${pullRequest.number}: ${change.subject}`);
    }
  }

  private saveStack(
    state: RepositoryState,
    previous: StoredStack | undefined,
    transition: StackTransition,
    changes: readonly StackChange[],
    pullRequests: readonly PullRequest[],
    base: string,
    remote: string,
  ): void {
    const synchronizedChanges = changes.map((change, index) => ({
      id: change.id,
      remoteBranch: change.remoteBranch,
      pullRequest: pullRequests[index]!.number,
      url: pullRequests[index]!.url,
    }));
    const storedChanges = changesForState(
      synchronizedChanges,
      transition,
      previous,
    );
    const updatedStack: StoredStack = {
      remote,
      base,
      changes: storedChanges,
    };
    const stackNumber = this.updatedStackNumber(
      transition,
      previous,
      pullRequests,
    );

    if (stackNumber !== undefined) {
      updatedStack.stackNumber = stackNumber;
    }

    writeUpdatedState(this.stateStore, state, previous, updatedStack);

    this.reporter.progress("Saved the local stack state");
  }

  private updatedStackNumber(
    transition: StackTransition,
    previous: StoredStack | undefined,
    pullRequests: readonly PullRequest[],
  ): number | undefined {
    if (transition.kind === "rebuild") {
      return this.github.stackNumberForPullRequest(pullRequests[0]!.number);
    }

    if (transition.kind === "collapse") {
      return undefined;
    }

    if (previous?.stackNumber !== undefined) {
      return previous.stackNumber;
    }

    if (pullRequests.length > 1) {
      return this.github.stackNumberForPullRequest(pullRequests[0]!.number);
    }

    return undefined;
  }

  private prepareTransition(
    transition: StackTransition,
    previous: StoredStack | undefined,
    base: string,
  ): void {
    if (transition.kind !== "rebuild" || transition.action !== "reorder") {
      return;
    }

    this.reporter.progress(
      `Preparing stack #${transition.stackNumber} for reordered branches`,
    );
    this.github.unstack(transition.stackNumber);

    try {
      for (const change of previous!.changes) {
        const pullRequest = this.github.pullRequest(change.pullRequest);

        if (pullRequest.state === "OPEN") {
          this.github.editPullRequestBase(pullRequest, base);
        }
      }
    } catch (error) {
      this.restorePreviousStack(previous!, error);
    }
  }

  private applyTransition(
    transition: StackTransition,
    previous: StoredStack | undefined,
    changes: readonly StackChange[],
    pullRequests: readonly PullRequest[],
    base: string,
    remote: string,
    draft: boolean,
  ): void {
    if (transition.kind === "retarget") {
      this.reporter.progress(`Updating the pull request base to ${base}`);
      this.github.editPullRequestBase(pullRequests[0]!, base);

      return;
    }

    if (changes.length === 1) {
      this.applySingleChangeTransition(
        transition,
        previous,
        pullRequests[0]!,
        base,
      );

      return;
    }

    switch (transition.kind) {
      case "full":
        this.linkFullStack(changes.length, pullRequests, base, remote, draft);
        break;
      case "rebuild":
        this.rebuildStack(
          transition,
          previous!,
          pullRequests,
          base,
          remote,
          draft,
        );
        break;
      case "append":
        this.appendToStack(transition, changes, pullRequests, remote, draft);
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
    previous: StoredStack | undefined,
    pullRequest: PullRequest,
    base: string,
  ): void {
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
      this.restorePreviousStack(previous!, error);
    }
  }

  private linkFullStack(
    changeCount: number,
    pullRequests: readonly PullRequest[],
    base: string,
    remote: string,
    draft: boolean,
  ): void {
    this.reporter.progress(
      `Linking ${changeCount} pull requests as a native GitHub stack`,
    );

    this.github.linkStack(
      pullRequests.map((pullRequest) => pullRequest.number),
      base,
      remote,
      draft,
    );
  }

  private rebuildStack(
    transition: Extract<StackTransition, { kind: "rebuild" }>,
    previous: StoredStack,
    pullRequests: readonly PullRequest[],
    base: string,
    remote: string,
    draft: boolean,
  ): void {
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
        pullRequests.map((pullRequest) => pullRequest.number),
        base,
        remote,
        draft,
      );
    } catch (error) {
      this.restorePreviousStack(previous, error);
    }
  }

  private appendToStack(
    transition: Extract<StackTransition, { kind: "append" }>,
    changes: readonly StackChange[],
    pullRequests: readonly PullRequest[],
    remote: string,
    draft: boolean,
  ): void {
    this.reporter.progress(
      `Appending ${transition.branches.length} pull request${transition.branches.length === 1 ? "" : "s"} to stack #${transition.stackNumber}`,
    );

    this.github.appendToStack(
      transition.stackNumber,
      transition.branches.map((branch) =>
        pullRequestNumberForBranch(branch, changes, pullRequests),
      ),
      remote,
      draft,
    );
  }

  private reportPartialUpdate(): void {
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

      if (pullRequests.length === 1) {
        this.github.editPullRequestBase(pullRequests[0]!, previous.base);
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

function isReorder(transition: StackTransition): boolean {
  return transition.kind === "rebuild" && transition.action === "reorder";
}

function pullRequestBaseFor(
  changes: readonly StackChange[],
  index: number,
  base: string,
): string {
  if (index === 0) {
    return base;
  }

  return changes[index - 1]!.remoteBranch;
}

function pullRequestNumberForBranch(
  branch: string,
  changes: readonly StackChange[],
  pullRequests: readonly PullRequest[],
): number {
  const index = changes.findIndex((change) => change.remoteBranch === branch);
  const pullRequest = pullRequests[index];

  if (!pullRequest) {
    throw new Error(`Missing pull request for ${branch}`);
  }

  return pullRequest.number;
}

function changesForState(
  synchronized: StoredChange[],
  transition: StackTransition,
  previous: StoredStack | undefined,
): StoredChange[] {
  if (transition.kind !== "partial" || !previous) {
    return synchronized;
  }

  const preserved = previous.changes.slice(
    transition.previousOffset + synchronized.length,
  );

  return [...synchronized, ...preserved];
}

function synchronizeChanges(
  changes: readonly StackChange[],
  pullRequests: readonly PullRequest[],
): SynchronizedChange[] {
  return changes.map((change, index) => ({
    ...change,
    pullRequest: pullRequests[index]!,
  }));
}

function buildOutcomes(
  synchronized: readonly SynchronizedChange[],
  omittedPullRequests: readonly PullRequest[],
  context: OutcomeContext,
): SyncOutcome[] {
  const synchronizedOutcomes = synchronized.map(
    (change, index): SyncOutcome => ({
      outcome: changeOutcome(change, index, change.pullRequest, context),
      change,
      pullRequest: change.pullRequest,
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
  change: StackChange,
  index: number,
  pullRequest: PullRequest,
  context: OutcomeContext,
): "created" | "updated" | "unchanged" {
  if (context.createdBranches.has(change.remoteBranch)) {
    return "created";
  }

  const previousBase = previousBaseFor(change, context.previous);
  const currentBase = pullRequestBaseFor(context.changes, index, context.base);
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
