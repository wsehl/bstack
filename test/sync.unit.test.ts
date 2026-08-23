import { describe, expect, test } from "vitest";
import type { BranchUpdate, CommitRewrite, GitRepository } from "../src/git";
import type { GitHubPlatform } from "../src/github";
import type {
  Commit,
  PullRequest,
  RepositoryState,
  StackChange,
} from "../src/model";
import type { Reporter } from "../src/reporter";
import type { StateStore } from "../src/state";
import { syncStack } from "../src/sync";

describe("stack sync boundaries", () => {
  test("dry run does not rewrite, push, read state, or change GitHub", () => {
    const repository = new SyncRepository([commit("one", false)]);
    const github = new SyncGitHub();
    const stateStore = new RecordingStateStore(emptyState);

    const result = syncStack(
      { repository, github, stateStore, reporter: silentReporter },
      {
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: true,
      },
    );

    expect(result.rewritten).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(repository.rewriteCalls).toEqual([]);
    expect(repository.pushCalls).toEqual([]);
    expect(stateStore.readCount).toBe(0);
    expect(stateStore.writes).toEqual([]);
    expect(github.mutations).toEqual([]);
  });

  test("restores the previous stack when a rebuild fails", () => {
    const repository = new SyncRepository([
      commit("new"),
      commit("one"),
      commit("two"),
    ]);
    const github = new SyncGitHub();
    const previousBranches = ["bstack/test-user/one", "bstack/test-user/two"];
    const state: RepositoryState = {
      schemaVersion: 1,
      stacks: [
        {
          remote: "origin",
          base: "main",
          stackNumber: 7,
          changes: previousBranches.map((remoteBranch, index) => ({
            id: index === 0 ? "one" : "two",
            remoteBranch,
            pullRequest: index + 1,
            url: `https://example.test/pull/${index + 1}`,
          })),
        },
      ],
    };
    const stateStore = new RecordingStateStore(state);
    const rebuildError = new Error("link failed");
    github.failNextLinkWith = rebuildError;

    expect(() =>
      syncStack(
        { repository, github, stateStore, reporter: silentReporter },
        {
          base: "main",
          remote: "origin",
          draft: false,
          dryRun: false,
        },
      ),
    ).toThrow(rebuildError);
    expect(github.unstackCalls).toEqual([7]);
    expect(github.linkCalls).toEqual([
      {
        branches: [
          "bstack/test-user/new",
          "bstack/test-user/one",
          "bstack/test-user/two",
        ],
        draft: false,
      },
      {
        branches: previousBranches,
        draft: true,
      },
    ]);
    expect(stateStore.writes).toEqual([]);
  });
});

const emptyState: RepositoryState = {
  schemaVersion: 1,
  stacks: [],
};

const silentReporter: Reporter = {
  progress() {},
};

function commit(id: string, withChangeId = true) {
  const message = withChangeId
    ? `Change ${id}\n\nbstack-id: ${id}\n`
    : `Change ${id}\n`;

  return {
    oid: `oid-${id}`,
    tree: `tree-${id}`,
    parent: `parent-${id}`,
    message,
    headers: [`tree tree-${id}`, `parent parent-${id}`],
    changeId: withChangeId ? id : undefined,
  };
}

class SyncRepository implements GitRepository {
  readonly rewriteCalls: CommitRewrite[][] = [];
  readonly pushCalls: Array<{
    remote: string;
    branches: readonly BranchUpdate[];
  }> = [];

  constructor(private readonly commits: Commit[]) {}

  assertReady() {}

  assertClean() {}

  currentBranch() {
    return "feature";
  }

  resolveRemote(requested?: string) {
    return requested ?? "origin";
  }

  fetchBase(remote: string, base: string) {
    return `refs/remotes/${remote}/${base}`;
  }

  fetchRemoteBranch() {
    return "remote-branch";
  }

  checkout() {
    throw new Error("Unexpected checkout");
  }

  mergeBase() {
    return "base-oid";
  }

  commitsSince() {
    return this.commits;
  }

  rewriteCommits(rewrites: readonly CommitRewrite[]) {
    this.rewriteCalls.push([...rewrites]);

    return rewrites.map((rewrite) => rewrite.commit.oid);
  }

  pushBranches(remote: string, branches: readonly BranchUpdate[]) {
    this.pushCalls.push({ remote, branches: [...branches] });
  }

  statePath() {
    return "/repo/.git/bstack/state.json";
  }
}

class SyncGitHub implements GitHubPlatform {
  readonly mutations: string[] = [];
  readonly unstackCalls: number[] = [];
  readonly linkCalls: Array<{ branches: string[]; draft: boolean }> = [];
  failNextLinkWith: Error | undefined;

  assertReady() {}

  currentUserLogin() {
    return "test-user";
  }

  defaultBranch() {
    return "main";
  }

  pullRequestForBranch(branch: string) {
    const id = branch.split("/").at(-1)!;
    const number = id === "one" ? 1 : id === "two" ? 2 : 3;

    return {
      number,
      url: `https://example.test/pull/${number}`,
      state: "OPEN",
      title: `Change ${id}`,
      body: "",
      isDraft: false,
    } satisfies PullRequest;
  }

  pullRequest(number: number) {
    return {
      number,
      url: `https://example.test/pull/${number}`,
      state: "OPEN",
      title: "",
      body: "",
      isDraft: false,
    } satisfies PullRequest;
  }

  createPullRequest() {
    this.mutations.push("create");

    return {
      number: 4,
      url: "https://example.test/pull/4",
      state: "OPEN",
      title: "Change",
      body: "",
      isDraft: false,
    } satisfies PullRequest;
  }

  linkStack(
    branches: readonly string[],
    _base: string,
    _remote: string,
    draft: boolean,
  ) {
    this.mutations.push("link");
    this.linkCalls.push({ branches: [...branches], draft });
    if (this.failNextLinkWith) {
      const error = this.failNextLinkWith;
      this.failNextLinkWith = undefined;
      throw error;
    }
  }

  appendToStack() {
    this.mutations.push("append");
  }

  unstack(stackNumber: number) {
    this.mutations.push("unstack");
    this.unstackCalls.push(stackNumber);
  }

  editPullRequestBase() {
    this.mutations.push("edit-base");
  }

  editPullRequest(_pr: PullRequest, _change: StackChange) {
    this.mutations.push("edit");
  }

  stackNumberForPullRequest() {
    return 7;
  }

  pullRequestHead() {
    return "bstack/test-user/change";
  }

  checkoutPullRequest() {
    this.mutations.push("checkout");
  }
}

class RecordingStateStore implements StateStore {
  readCount = 0;
  readonly writes: RepositoryState[] = [];

  constructor(private readonly state: RepositoryState) {}

  read() {
    this.readCount += 1;

    return this.state;
  }

  write(state: RepositoryState) {
    this.writes.push(state);
  }
}
