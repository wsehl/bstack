import type { GitHubPlatform } from "./github";
import type { PullRequest, StackChange, StoredStack } from "./model";
import type { Reporter } from "./reporter";
import type { StackTransition } from "./stack";

export function prepareStackTransition(
  transition: StackTransition,
  github: GitHubPlatform,
  previous: StoredStack | undefined,
  base: string,
  reporter: Reporter,
): void {
  if (transition.kind !== "rebuild" || transition.action !== "reorder") {
    return;
  }

  reporter.progress(
    `Preparing stack #${transition.stackNumber} for reordered branches`,
  );
  github.unstack(transition.stackNumber);
  try {
    for (const change of previous!.changes) {
      const pullRequest = github.pullRequest(change.pullRequest);
      if (pullRequest.state === "OPEN") {
        github.editPullRequestBase(pullRequest, base);
      }
    }
  } catch (error) {
    restorePreviousStack(github, previous!, reporter, error);
  }
}

export function applyStackTransition(
  transition: StackTransition,
  github: GitHubPlatform,
  previous: StoredStack | undefined,
  changes: readonly StackChange[],
  pullRequests: readonly PullRequest[],
  base: string,
  remote: string,
  draft: boolean,
  reporter: Reporter,
): void {
  if (transition.kind === "retarget") {
    reporter.progress(`Updating the pull request base to ${base}`);
    github.editPullRequestBase(pullRequests[0]!, base);

    return;
  }

  if (changes.length === 1) {
    if (transition.kind === "partial") {
      reporter.progress(
        "Updating this down-stack prefix while preserving higher pull requests",
      );
    }
    if (transition.kind === "collapse") {
      reporter.progress(
        `Removing omitted pull requests from stack #${transition.stackNumber}`,
      );
      github.unstack(transition.stackNumber);
      try {
        github.editPullRequestBase(pullRequests[0]!, base);
      } catch (error) {
        restorePreviousStack(github, previous!, reporter, error);
      }
    }
    return;
  }

  if (transition.kind === "full") {
    reporter.progress(
      `Linking ${changes.length} pull requests as a native GitHub stack`,
    );
    github.linkStack(
      pullRequests.map((pullRequest) => pullRequest.number),
      base,
      remote,
      draft,
    );

    return;
  }

  if (transition.kind === "rebuild") {
    const reason =
      transition.action === "change-base"
        ? `against ${base}`
        : `to ${transition.action} pull requests`;
    reporter.progress(`Rebuilding stack #${transition.stackNumber} ${reason}`);
    if (transition.action !== "reorder") {
      github.unstack(transition.stackNumber);
    }
    try {
      github.linkStack(
        pullRequests.map((pullRequest) => pullRequest.number),
        base,
        remote,
        draft,
      );
    } catch (error) {
      restorePreviousStack(github, previous!, reporter, error);
    }

    return;
  }

  if (transition.kind === "append") {
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
      draft,
    );

    return;
  }

  if (transition.kind === "partial") {
    reporter.progress(
      "Updating this down-stack prefix while preserving higher pull requests",
    );

    return;
  }

  reporter.progress("The native GitHub stack already has the correct members");
}

export function restorePreviousStack(
  github: GitHubPlatform,
  previous: StoredStack,
  reporter: Reporter,
  rebuildError: unknown,
): never {
  const rebuildMessage =
    rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
  reporter.progress(
    "Rebuild failed; restoring the previous native GitHub stack",
  );
  try {
    const pullRequests = previous.changes
      .map((change) => github.pullRequest(change.pullRequest))
      .filter((pullRequest) => pullRequest.state === "OPEN");
    if (pullRequests.length === 1) {
      github.editPullRequestBase(pullRequests[0]!, previous.base);
    } else if (pullRequests.length > 1) {
      github.linkStack(
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
    );
  }
  throw rebuildError;
}
