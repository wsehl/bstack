import type { GitRepository } from "../git";
import type { GitHubPlatform } from "../github";
import type { Reporter } from "../reporter";

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

export class CheckoutCommand {
  constructor(
    private readonly repository: GitRepository,
    private readonly github: GitHubPlatform,
    private readonly reporter: Reporter,
  ) {}

  run(options: CheckoutOptions): CheckoutResult {
    this.reporter.progress("Checking the repository and GitHub prerequisites");

    this.repository.assertReady();

    if (!this.repository.isClean()) {
      throw new Error("The working tree must be clean before checkout");
    }

    this.github.assertReady();

    const remote = this.repository.resolveRemote(options.remote);

    this.reporter.progress(`Looking up pull request ${options.reference}`);

    const headRef = this.github.pullRequestHead(options.reference);
    if (!headRef.startsWith("bstack/")) {
      this.reporter.progress(
        "This is not a bstack pull request; delegating to gh pr checkout",
      );
      this.github.checkoutPullRequest(options.reference);

      return {
        headRef,
        delegated: true,
      };
    }

    let currentBase: string | undefined;
    let remoteBase: string | undefined;
    if (options.sameBase) {
      const base = options.base ?? this.github.defaultBranch();
      this.reporter.progress(
        `Checking that the merge base remains on ${remote}/${base}`,
      );
      remoteBase = this.repository.fetchBase(remote, base);
      currentBase = this.repository.mergeBase("HEAD", remoteBase);
    }

    this.reporter.progress(`Fetching ${remote}/${headRef}`);
    const target = this.repository.fetchRemoteBranch(remote, headRef);
    if (currentBase && remoteBase) {
      const targetBase = this.repository.mergeBase(target, remoteBase);
      if (currentBase !== targetBase) {
        throw new Error(
          `Checkout would change the merge base from ${currentBase.slice(0, 8)} to ${targetBase.slice(0, 8)}`,
        );
      }
    }

    this.reporter.progress(
      `Checking out ${remote}/${headRef} in detached HEAD state`,
    );
    this.repository.checkout(target);
    this.reporter.progress(
      "Checkout complete; amend the commits and run bstack to sync updates",
    );

    return {
      headRef,
      delegated: false,
    };
  }
}
