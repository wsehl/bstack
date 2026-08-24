import type { GitHubPlatform } from "./github";
import type { PullRequest, StackChange, StoredStack } from "./model";
import type { Reporter } from "./reporter";
import type { StackTransition } from "./stack";

export function prepareStackTransition(
  transition: StackTransition,
  github: GitHubPlatform,
  previous: StoredStack | undefined,
  base: string,
  remote: string,
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
      github.editPullRequestBase(github.pullRequest(change.pullRequest), base);
    }
  } catch (error) {
    restorePreviousStack(github, previous!, base, remote, reporter, error);
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
        restorePreviousStack(github, previous!, base, remote, reporter, error);
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
    reporter.progress(
      `Rebuilding stack #${transition.stackNumber} to ${transition.action} pull requests`,
    );
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
      restorePreviousStack(github, previous!, base, remote, reporter, error);
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
