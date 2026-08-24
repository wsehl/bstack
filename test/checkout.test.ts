import { describe, expect, test } from "vitest";
import { checkoutStack } from "../src/checkout";
import type { GitRepository } from "../src/git";
import type { GitHubPlatform } from "../src/github";
import type { PullRequest } from "../src/model";
import type { Reporter } from "../src/reporter";

describe("stack checkout", () => {
  test("refuses checkout when the working tree is dirty", () => {
    const repository = new CheckoutRepository();
    repository.clean = false;
    const github = new CheckoutGitHub("bstack/user/change-id");

    expect(() =>
      checkoutStack(
        { repository, github, reporter: silentReporter },
        {
          reference: "42",
          base: undefined,
          remote: undefined,
          sameBase: false,
        },
      ),
    ).toThrow("The working tree must be clean before checkout");
    expect(repository.fetchedBranches).toEqual([]);
    expect(repository.checkedOutRefs).toEqual([]);
    expect(github.delegatedReferences).toEqual([]);
  });

  test("delegates ordinary pull requests to GitHub CLI", () => {
    const repository = new CheckoutRepository();
    const github = new CheckoutGitHub("feature/ordinary");

    const result = checkoutStack(
      { repository, github, reporter: silentReporter },
      {
        reference: "42",
        base: undefined,
        remote: undefined,
        sameBase: false,
      },
    );

    expect(result).toEqual({
      headRef: "feature/ordinary",
      delegated: true,
    });
    expect(github.delegatedReferences).toEqual(["42"]);
    expect(repository.fetchedBranches).toEqual([]);
    expect(repository.checkedOutRefs).toEqual([]);
  });

  test("refuses a bstack checkout that would change the merge base", () => {
    const repository = new CheckoutRepository();
    repository.mergeBases = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ];
    const github = new CheckoutGitHub("bstack/user/change-id");

    expect(() =>
      checkoutStack(
        { repository, github, reporter: silentReporter },
        {
          reference: "42",
          base: "main",
          remote: "origin",
          sameBase: true,
        },
      ),
    ).toThrow("Checkout would change the merge base from aaaaaaaa to bbbbbbbb");
    expect(repository.fetchedBranches).toEqual([
      { remote: "origin", branch: "bstack/user/change-id" },
    ]);
    expect(repository.checkedOutRefs).toEqual([]);
    expect(github.delegatedReferences).toEqual([]);
  });
});

const silentReporter: Reporter = {
  progress() {},
};

const pullRequest: PullRequest = {
  number: 1,
  url: "https://example.test/pull/1",
  state: "OPEN",
  title: "Change",
  body: "",
  isDraft: false,
};

class CheckoutRepository implements GitRepository {
  readonly fetchedBranches: Array<{ remote: string; branch: string }> = [];
  readonly checkedOutRefs: string[] = [];
  mergeBases = ["base"];
  clean = true;

  assertReady() {}

  isClean() {
    return this.clean;
  }

  currentBranch() {
    return "feature";
  }

  resolveRemote(requested?: string) {
    return requested ?? "origin";
  }

  fetchBase(remote: string, base: string) {
    return `refs/remotes/${remote}/${base}`;
  }

  fetchRemoteBranch(remote: string, branch: string) {
    this.fetchedBranches.push({ remote, branch });

    return `refs/remotes/${remote}/${branch}`;
  }

  checkout(ref: string) {
    this.checkedOutRefs.push(ref);
  }

  mergeBase() {
    const mergeBase = this.mergeBases.shift();
    if (!mergeBase) {
      throw new Error("Unexpected merge-base lookup");
    }

    return mergeBase;
  }

  commitsSince() {
    return [];
  }

  rewriteCommits() {
    return [];
  }

  pushBranches() {
    throw new Error("Unexpected branch push");
  }

  statePath() {
    return "/repo/.git/bstack/state.json";
  }
}

class CheckoutGitHub implements GitHubPlatform {
  readonly delegatedReferences: string[] = [];

  constructor(private readonly headRef: string) {}

  assertReady() {}

  currentUserLogin() {
    return "test-user";
  }

  defaultBranch() {
    return "main";
  }

  pullRequestForBranch() {
    return undefined;
  }

  pullRequest() {
    return pullRequest;
  }

  createPullRequest() {
    return pullRequest;
  }

  linkStack() {
    throw new Error("Unexpected stack link");
  }

  appendToStack() {
    throw new Error("Unexpected stack append");
  }

  unstack() {
    throw new Error("Unexpected unstack");
  }

  closePullRequest() {
    throw new Error("Unexpected pull request close");
  }

  editPullRequestBase() {
    throw new Error("Unexpected pull request edit");
  }

  editPullRequest() {
    throw new Error("Unexpected pull request edit");
  }

  stackNumberForPullRequest() {
    return undefined;
  }

  pullRequestHead() {
    return this.headRef;
  }

  checkoutPullRequest(reference: string) {
    this.delegatedReferences.push(reference);
  }
}
