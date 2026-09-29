import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test } from "vitest";

import { SyncCommand } from "../src/commands/sync";
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

describe("stack sync", () => {
  test("rejects duplicate stable IDs before sync can push", () => {
    const repository = new SyncRepository([commit("same"), commit("same")]);
    const github = new SyncGitHub();
    const stateStore = new RecordingStateStore(emptyState);

    expect(() =>
      command(repository, github, stateStore).run({
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        closeOmitted: false,
      }),
    ).toThrow("A stack cannot contain duplicate bstack-id same");
    expect(repository.pushCalls).toEqual([]);
    expect(stateStore.readCount).toBe(0);
    expect(github.mutations).toEqual([]);
  });

  test("dry run plans without rewriting, pushing, saving, or changing GitHub", () => {
    const repository = new SyncRepository([commit("one", false)]);
    const github = new SyncGitHub();
    const stateStore = new RecordingStateStore(emptyState);

    const result = command(repository, github, stateStore).run({
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: true,
      closeOmitted: false,
    });

    expect(result.rewritten).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ outcome: "update" }),
    ]);
    expect(repository.rewriteCalls).toEqual([]);
    expect(repository.pushCalls).toEqual([]);
    expect(stateStore.writes).toEqual([]);
    expect(github.mutations).toEqual([]);
  });

  test("dry run reports pull requests to update, keep, and close", () => {
    const repository = new SyncRepository([commit("one"), commit("two")]);
    repository.outdated = ["bstack/test-user/two"];
    const github = new SyncGitHub();

    const stateStore = new RecordingStateStore({
      schemaVersion: 1,
      stacks: [
        {
          remote: "origin",
          base: "main",
          stackNumber: 7,
          changes: ["one", "dropped", "two"].map((id, index) => ({
            id,
            remoteBranch: `bstack/test-user/${id}`,
            pullRequest: [1, 5, 2][index]!,
            url: `https://example.test/pull/${[1, 5, 2][index]!}`,
          })),
        },
      ],
    });

    const result = command(repository, github, stateStore).run({
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: true,
      closeOmitted: false,
    });

    expect(result).toMatchObject({
      dryRun: true,
      stackAction: "rebuild stack #7 to remove pull requests",
      outcomes: [
        { outcome: "unchanged", pullRequest: { number: 1 } },
        { outcome: "update", pullRequest: { number: 2 } },
        { outcome: "close", pullRequest: { number: 5 } },
      ],
    });
    expect(repository.pushCalls).toEqual([]);
    expect(stateStore.writes).toEqual([]);
    expect(github.mutations).toEqual([]);
  });

  test("refuses to sync a change whose pull request is already merged", () => {
    const repository = new SyncRepository([commit("one"), commit("two")]);
    const github = new SyncGitHub();
    github.mergedBranches.add("bstack/test-user/one");
    const stateStore = new RecordingStateStore(emptyState);

    expect(() =>
      command(repository, github, stateStore).run({
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        closeOmitted: false,
      }),
    ).toThrow(
      "Pull request #1 (Change one) is already merged but still in the local stack. Rebase onto origin/main and run bstack again",
    );
    expect(repository.pushCalls).toEqual([]);
    expect(github.mutations).toEqual([]);
    expect(stateStore.writes).toEqual([]);
  });

  test("refuses to close pull requests of a stack synced from another branch", () => {
    const repository = new SyncRepository([commit("two")]);
    const github = new SyncGitHub();
    const stateStore = new RecordingStateStore(stackFromBranch("feature"));
    repository.branch = "cherry-picked";

    expect(() =>
      command(repository, github, stateStore).run({
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        closeOmitted: false,
      }),
    ).toThrow(
      "These commits belong to a stack last synced from feature, but HEAD is on cherry-picked. Syncing would close #1. Switch back to feature, or pass --close-omitted if you meant to drop them",
    );
    expect(repository.pushCalls).toEqual([]);
    expect(github.mutations).toEqual([]);
    expect(stateStore.writes).toEqual([]);
  });

  test("closes omitted pull requests from another branch when allowed", () => {
    const repository = new SyncRepository([commit("two")]);
    const github = new SyncGitHub();
    const stateStore = new RecordingStateStore(stackFromBranch("feature"));
    repository.branch = "renamed";

    command(repository, github, stateStore).run({
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      closeOmitted: true,
    });

    expect(github.mutations).toContain("close");
    expect(stateStore.writes.at(-1)?.stacks[0]?.branch).toBe("renamed");
  });

  test.each([
    ["feature", "feature"],
    [undefined, "feature"],
  ])(
    "records the branch the stack was synced from when HEAD is %s",
    (branch, expected) => {
      const repository = new SyncRepository([commit("one"), commit("two")]);
      const stateStore = new RecordingStateStore(stackFromBranch("feature"));
      repository.branch = branch;

      command(repository, new SyncGitHub(), stateStore).run({
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        closeOmitted: false,
      });

      expect(stateStore.writes.at(-1)?.stacks[0]?.branch).toBe(expected);
    },
  );

  test("rebuilds unchanged pull requests when the stack base changes", () => {
    const repository = new SyncRepository([commit("one"), commit("two")]);
    const github = new SyncGitHub();

    const stateStore = new RecordingStateStore({
      schemaVersion: 1,
      stacks: [
        {
          remote: "origin",
          base: "main",
          stackNumber: 7,
          changes: ["one", "two"].map((id, index) => ({
            id,
            remoteBranch: `bstack/test-user/${id}`,
            pullRequest: index + 1,
            url: `https://example.test/pull/${index + 1}`,
          })),
        },
      ],
    });

    command(repository, github, stateStore).run({
      base: "release",
      remote: "origin",
      draft: false,
      dryRun: false,
      closeOmitted: false,
    });

    expect(github.unstackCalls).toEqual([7]);
    expect(github.linkCalls).toEqual([
      {
        pullRequests: [1, 2],
        base: "release",
        draft: false,
      },
    ]);
    expect(stateStore.writes.at(-1)?.stacks[0]?.base).toBe("release");
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
      command(repository, github, stateStore).run({
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        closeOmitted: false,
      }),
    ).toThrow(rebuildError);
    expect(github.unstackCalls).toEqual([7]);
    expect(github.linkCalls).toEqual([
      {
        pullRequests: [3, 1, 2],
        base: "main",
        draft: false,
      },
      {
        pullRequests: [1, 2],
        base: "main",
        draft: true,
      },
    ]);
    expect(stateStore.writes).toEqual([]);
  });

  test("restores the previous stack when a reordered branch push fails", () => {
    const repository = new SyncRepository([commit("two"), commit("one")]);
    const github = new SyncGitHub();

    const stateStore = new RecordingStateStore({
      schemaVersion: 1,
      stacks: [
        {
          remote: "origin",
          base: "main",
          stackNumber: 7,
          changes: ["one", "two"].map((id, index) => ({
            id,
            remoteBranch: `bstack/test-user/${id}`,
            pullRequest: index + 1,
            url: `https://example.test/pull/${index + 1}`,
          })),
        },
      ],
    });

    const pushError = new Error("push failed");
    repository.failPushWith = pushError;

    expect(() =>
      command(repository, github, stateStore).run({
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        closeOmitted: false,
      }),
    ).toThrow(pushError);
    expect(github.unstackCalls).toEqual([7]);
    expect(github.mutations).toEqual([
      "unstack",
      "edit-base",
      "edit-base",
      "link",
    ]);
    expect(github.linkCalls).toEqual([
      {
        pullRequests: [1, 2],
        base: "main",
        draft: true,
      },
    ]);
    expect(stateStore.writes).toEqual([]);
  });

  test("updates the matched stack by index without replacing another stack", () => {
    const repository = new SyncRepository([commit("one")]);
    const github = new SyncGitHub();

    const unrelated = {
      remote: "origin",
      base: "main",
      changes: [
        {
          id: "unrelated",
          remoteBranch: "bstack/test-user/unrelated",
          pullRequest: 20,
          url: "https://example.test/pull/20",
        },
      ],
    };

    const stateStore = new RecordingStateStore({
      schemaVersion: 1,
      stacks: [
        unrelated,
        {
          remote: "origin",
          base: "main",
          changes: [
            {
              id: "one",
              remoteBranch: "bstack/test-user/one",
              pullRequest: 1,
              url: "https://example.test/pull/1",
            },
          ],
        },
      ],
    });

    command(repository, github, stateStore).run({
      base: "release",
      remote: "origin",
      draft: false,
      dryRun: false,
      closeOmitted: false,
    });

    expect(stateStore.writes.at(-1)?.stacks).toEqual([
      unrelated,
      expect.objectContaining({
        base: "release",
        changes: [expect.objectContaining({ id: "one" })],
      }),
    ]);
  });
});

const emptyState: RepositoryState = {
  schemaVersion: 1,
  stacks: [],
};

function stackFromBranch(branch: string): RepositoryState {
  return {
    schemaVersion: 1,
    stacks: [
      {
        remote: "origin",
        base: "main",
        branch,
        stackNumber: 7,
        changes: ["one", "two"].map((id, index) => ({
          id,
          remoteBranch: `bstack/test-user/${id}`,
          pullRequest: index + 1,
          url: `https://example.test/pull/${index + 1}`,
        })),
      },
    ],
  };
}

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

class SyncRepository {
  readonly rewriteCalls: CommitRewrite[][] = [];
  readonly pushCalls: Array<{
    remote: string;
    branches: readonly BranchUpdate[];
  }> = [];
  failPushWith: Error | undefined;
  outdated: string[] | undefined;

  constructor(private readonly commits: Commit[]) {}

  assertReady() {}

  branch: string | undefined = "feature";

  currentBranch() {
    return this.branch;
  }

  resolveRemote(requested?: string) {
    return requested ?? "origin";
  }

  fetchBase(remote: string, base: string) {
    return `refs/remotes/${remote}/${base}`;
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

  outdatedBranches(_remote: string, branches: readonly BranchUpdate[]) {
    return this.outdated ?? branches.map((branch) => branch.name);
  }

  pushBranches(remote: string, branches: readonly BranchUpdate[]) {
    if (this.failPushWith) {
      throw this.failPushWith;
    }

    this.pushCalls.push({ remote, branches: [...branches] });

    return {
      checked: branches.length,
      updated: branches.map((branch) => branch.name),
    };
  }
}

class SyncGitHub {
  readonly mutations: string[] = [];
  readonly unstackCalls: number[] = [];
  readonly linkCalls: Array<{
    pullRequests: number[];
    base: string;
    draft: boolean;
  }> = [];
  failNextLinkWith: Error | undefined;
  readonly mergedBranches = new Set<string>();

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
      state: this.mergedBranches.has(branch) ? "MERGED" : "OPEN",
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
    pullRequests: readonly number[],
    base: string,
    _remote: string,
    draft: boolean,
  ) {
    this.mutations.push("link");
    this.linkCalls.push({ pullRequests: [...pullRequests], base, draft });

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

  closePullRequest() {
    this.mutations.push("close");
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

function command(
  repository: SyncRepository,
  github: SyncGitHub,
  stateStore: StateStore,
) {
  return new SyncCommand(
    fromPartial<GitRepository>(repository),
    fromPartial<GitHubPlatform>(github),
    silentReporter,
    stateStore,
  );
}
