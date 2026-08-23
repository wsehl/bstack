import type { GitRepository } from "./git";
import type { GitHubPlatform } from "./github";
import type { Reporter } from "./reporter";

export type CheckoutDependencies = {
  repository: GitRepository;
  github: GitHubPlatform;
  reporter: Reporter;
};

export type CheckoutOptions = {
  reference: string;
  base: string | undefined;
  remote: string | undefined;
  sameBase: boolean;
};

export type CheckoutResult = {
  headRef: string;
  delegated: boolean;
};

export function checkoutStack(
  dependencies: CheckoutDependencies,
  options: CheckoutOptions,
): CheckoutResult {
  const { repository, github, reporter } = dependencies;

  reporter.progress("Checking the repository and GitHub prerequisites");
  repository.assertReady();
  repository.assertClean();
  github.assertReady();

  const remote = repository.resolveRemote(options.remote);
  reporter.progress(`Looking up pull request ${options.reference}`);

  const headRef = github.pullRequestHead(options.reference);
  if (!headRef.startsWith("bstack/")) {
    reporter.progress(
      "This is not a bstack pull request; delegating to gh pr checkout",
    );
    github.checkoutPullRequest(options.reference);

    return {
      headRef,
      delegated: true,
    };
  }

  let currentBase: string | undefined;
  let remoteBase: string | undefined;
  if (options.sameBase) {
    const base = options.base ?? github.defaultBranch();
    reporter.progress(
      `Checking that the merge base remains on ${remote}/${base}`,
    );
    remoteBase = repository.fetchBase(remote, base);
    currentBase = repository.mergeBase("HEAD", remoteBase);
  }

  reporter.progress(`Fetching ${remote}/${headRef}`);
  const target = repository.fetchRemoteBranch(remote, headRef);
  if (currentBase && remoteBase) {
    const targetBase = repository.mergeBase(target, remoteBase);
    if (currentBase !== targetBase) {
      throw new Error(
        `Checkout would change the merge base from ${currentBase.slice(0, 8)} to ${targetBase.slice(0, 8)}`,
      );
    }
  }

  reporter.progress(`Checking out ${remote}/${headRef} in detached HEAD state`);
  repository.checkout(target);
  reporter.progress(
    "Checkout complete; amend the commits and run bstack to sync updates",
  );

  return {
    headRef,
    delegated: false,
  };
}
