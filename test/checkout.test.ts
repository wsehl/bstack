import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test } from "vitest";

import { CheckoutCommand } from "../src/commands/checkout";
import type { GitRepository } from "../src/git";
import type { GitHubPlatform } from "../src/github";
import type { Reporter } from "../src/reporter";

describe("stack checkout", () => {
  test("refuses checkout when the working tree is dirty", () => {
    const repository = new FakeCheckoutRepository();
    repository.clean = false;
    const github = new FakeCheckoutGitHub("bstack/user/change-id");
    const command = new CheckoutCommand(
      fromPartial<GitRepository>(repository),
      fromPartial<GitHubPlatform>(github),
      silentReporter,
    );

    expect(() =>
      command.run({
        reference: "42",
        base: undefined,
        remote: undefined,
        sameBase: false,
      }),
    ).toThrow("The working tree must be clean before checkout");
    expect(repository.fetchedBranches).toEqual([]);
    expect(repository.checkedOutRefs).toEqual([]);
    expect(github.delegatedReferences).toEqual([]);
  });

  test("delegates ordinary pull requests to GitHub CLI", () => {
    const repository = new FakeCheckoutRepository();
    const github = new FakeCheckoutGitHub("feature/ordinary");

    const command = new CheckoutCommand(
      fromPartial<GitRepository>(repository),
      fromPartial<GitHubPlatform>(github),
      silentReporter,
    );
    const result = command.run({
      reference: "42",
      base: undefined,
      remote: undefined,
      sameBase: false,
    });

    expect(result).toEqual({
      headRef: "feature/ordinary",
      delegated: true,
    });
    expect(github.delegatedReferences).toEqual(["42"]);
    expect(repository.fetchedBranches).toEqual([]);
    expect(repository.checkedOutRefs).toEqual([]);
  });

  test("refuses a bstack checkout that would change the merge base", () => {
    const repository = new FakeCheckoutRepository();
    repository.mergeBases = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ];
    const github = new FakeCheckoutGitHub("bstack/user/change-id");
    const command = new CheckoutCommand(
      fromPartial<GitRepository>(repository),
      fromPartial<GitHubPlatform>(github),
      silentReporter,
    );

    expect(() =>
      command.run({
        reference: "42",
        base: "main",
        remote: "origin",
        sameBase: true,
      }),
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

class FakeCheckoutRepository {
  readonly fetchedBranches: Array<{ remote: string; branch: string }> = [];
  readonly checkedOutRefs: string[] = [];
  mergeBases = ["base"];
  clean = true;

  assertReady() {}

  isClean() {
    return this.clean;
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
}

class FakeCheckoutGitHub {
  readonly delegatedReferences: string[] = [];

  constructor(private readonly headRef: string) {}

  assertReady() {}

  defaultBranch() {
    return "main";
  }

  pullRequestHead() {
    return this.headRef;
  }

  checkoutPullRequest(reference: string) {
    this.delegatedReferences.push(reference);
  }
}
