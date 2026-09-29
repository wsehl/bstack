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
} & (
  | { dryRun: false; outcomes: SyncOutcome[] }
  | {
      dryRun: true;
      outcomes: PlannedOutcome[];
      stackAction: string | undefined;
    }
);

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

export type PlannedOutcome =
  | { outcome: "create"; change: StackChange }
  | {
      outcome: "update" | "unchanged";
      change: StackChange;
      pullRequest: PullRequest;
    }
  | { outcome: "close"; pullRequest: PullRequest };

type PreparedStack = {
  base: string;
  remote: string;
  stack: Stack;
};

type ExistingPullRequest = {
  change: StackChange;
  current: PullRequest | undefined;
};

type SyncPlan = {
  state: RepositoryState;
  previousEntry: StoredStackEntry | undefined;
  transition: StackTransition;
  existing: ExistingPullRequest[];
  omitted: PullRequest[];
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
    const plan = this.plan(stack, base, remote);

    if (options.dryRun) {
      return this.dryRunResult(stack, plan, base, remote);
    }

    return this.synchronize(stack, plan, options, base, remote);
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

  // Everything the sync will do is decided here with read-only lookups, so
  // a dry run can report it without changing anything.
  private plan(stack: Stack, base: string, remote: string): SyncPlan {
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

    this.reporter.progress("Looking up existing pull requests");

    const existing = stack.changes.map((change) => ({
      change,
      current: this.github.pullRequestForBranch(change.remoteBranch),
    }));

    assertNoMergedChanges(existing, `${remote}/${base}`);

    const omitted = this.omittedPullRequests(transition, stack.changes);

    return { state, previousEntry, transition, existing, omitted };
  }

  private dryRunResult(
    stack: Stack,
    plan: SyncPlan,
    base: string,
    remote: string,
  ): SyncResult {
    const { changes, rewritten } = stack;

    const outdatedBranches = new Set(
      this.repository.outdatedBranches(remote, branchUpdates(changes)),
    );

    const context: OutcomeContext = {
      previous: plan.transition.previous,
      base,
      pushedBranches: outdatedBranches,
    };

    const changeOutcomes = plan.existing.map(
      ({ change, current }, index): PlannedOutcome => {
        if (!current) {
          return { outcome: "create", change };
        }

        const outcome = changeOutcome(
          change,
          current,
          changes[index - 1]?.remoteBranch ?? base,
          context,
        );

        return {
          outcome: outcome === "updated" ? "update" : "unchanged",
          change,
          pullRequest: current,
        };
      },
    );

    const closeOutcomes = plan.omitted.map((pullRequest): PlannedOutcome => ({
      outcome: "close",
      pullRequest,
    }));

    this.reporter.progress(
      "Dry run complete; no commits, branches, or pull requests were changed",
    );

    return {
      dryRun: true,
      base,
      remote,
      rewritten,
      changes: plan.existing.map(({ change, current }) =>
        current ? { ...change, pullRequest: current } : change,
      ),
      outcomes: [...changeOutcomes, ...closeOutcomes],
      stackAction: describeStackAction(plan.transition, changes.length, base),
    };
  }

  private synchronize(
    stack: Stack,
    plan: SyncPlan,
    options: SyncOptions,
    base: string,
    remote: string,
  ): SyncResult {
    const { changes, rewritten } = stack;
    const { state, previousEntry, transition } = plan;

    this.prepareTransition(transition, base);
    const pushedBranches = this.pushBranches(remote, changes, transition);

    const matchedChanges = this.createMissingPullRequests(
      plan.existing,
      base,
      options.draft,
    );

    this.applyTransition(
      transition,
      matchedChanges,
      base,
      remote,
      options.draft,
    );

    this.closeOmittedPullRequests(plan.omitted);

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

    const outcomes = buildOutcomes(matchedChanges, plan.omitted, {
      previous: transition.previous,
      base,
      pushedBranches,
    });

    return {
      dryRun: false,
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
        branchUpdates(changes),
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

  private createMissingPullRequests(
    existing: readonly ExistingPullRequest[],
    base: string,
    draft: boolean,
  ): MatchedChange[] {
    const matchedChanges: MatchedChange[] = [];

    for (const { change, current } of existing) {
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
    omittedPullRequests: readonly PullRequest[],
  ) {
    if (omittedPullRequests.length === 0) {
      return;
    }

    this.reporter.progress(
      `Closing ${omittedPullRequests.length} omitted pull request${omittedPullRequests.length === 1 ? "" : "s"}`,
    );

    for (const pullRequest of omittedPullRequests) {
      this.github.closePullRequest(pullRequest);
    }
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
    this.reporter.progress(
      `Rebuilding stack #${transition.stackNumber} ${rebuildReason(transition, base)}`,
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

// A squash or rebase merge leaves the original commit in local history until
// the branch is rebased. Syncing it would re-push the merged branch and keep
// the merged changes in every PR above it.
function assertNoMergedChanges(
  existing: readonly ExistingPullRequest[],
  remoteBase: string,
) {
  const merged = existing.filter(({ current }) => current?.state === "MERGED");

  if (merged.length === 0) {
    return;
  }

  const pullRequests = merged
    .map(({ change, current }) => `#${current!.number} (${change.subject})`)
    .join(", ");

  throw new Error(
    `${merged.length === 1 ? "Pull request" : "Pull requests"} ${pullRequests} ${merged.length === 1 ? "is" : "are"} already merged but still in the local stack. Rebase onto ${remoteBase} and run bstack again`,
  );
}

function branchUpdates(changes: readonly StackChange[]) {
  return changes.map((change) => ({
    name: change.remoteBranch,
    oid: change.oid,
  }));
}

function rebuildReason(
  transition: Extract<StackTransition, { kind: "rebuild" }>,
  base: string,
): string {
  return transition.action === "change-base"
    ? `against ${base}`
    : `to ${transition.action} pull requests`;
}

// Mirrors applyTransition, which leaves a single pull request unstacked.
function describeStackAction(
  transition: StackTransition,
  changeCount: number,
  base: string,
): string | undefined {
  switch (transition.kind) {
    case "retarget":
      return `change the pull request base to ${base}`;
    case "partial":
      return "update this down-stack prefix and keep higher pull requests";
    case "collapse":
      return `remove the omitted pull requests from stack #${transition.stackNumber}`;
    default:
  }

  if (changeCount === 1) {
    return undefined;
  }

  switch (transition.kind) {
    case "full":
      return `link ${changeCount} pull requests as a native GitHub stack`;
    case "rebuild":
      return `rebuild stack #${transition.stackNumber} ${rebuildReason(transition, base)}`;
    case "append":
      return `append ${transition.branches.length} pull request${transition.branches.length === 1 ? "" : "s"} to stack #${transition.stackNumber}`;
    default:
      return undefined;
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
    ({ change, pullRequest, created }, index): SyncOutcome => ({
      outcome: created
        ? "created"
        : changeOutcome(
            change,
            pullRequest,
            matchedChanges[index - 1]?.change.remoteBranch ?? context.base,
            context,
          ),
      change,
      pullRequest,
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
  pullRequest: PullRequest,
  currentBase: string,
  context: OutcomeContext,
): "updated" | "unchanged" {
  const previousBase = previousBaseFor(change, context.previous);

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

export function formatSyncResult(result: SyncResult): string {
  if (result.dryRun) {
    return formatPlannedSync(result);
  }

  const lines = [
    `Synced ${result.changes.length}-commit stack against ${result.base}:`,
  ];

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

function formatPlannedSync(
  result: Extract<SyncResult, { dryRun: true }>,
): string {
  const changeCount = `${result.changes.length} change${result.changes.length === 1 ? "" : "s"}`;
  const lines = [`Would sync ${changeCount} against ${result.base}:`];

  for (const outcome of result.outcomes) {
    const label = outcome.outcome.padEnd(9);

    if (outcome.outcome === "create") {
      lines.push(
        `  ${label} ${outcome.change.oid.slice(0, 8)}  ${outcome.change.subject}`,
      );
    } else if (outcome.outcome === "close") {
      const { pullRequest } = outcome;

      lines.push(
        `  ${label} #${pullRequest.number}  ${pullRequest.title} ${pullRequest.url}`,
      );
    } else {
      lines.push(
        `  ${label} #${outcome.pullRequest.number}  ${outcome.change.subject} ${outcome.pullRequest.url}`,
      );
    }
  }

  if (result.stackAction) {
    lines.push(`Would ${result.stackAction}`);
  }

  return lines.join("\n");
}
