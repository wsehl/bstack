import { describe, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeCommandRunner } from "../src/command";
import { checkoutStack } from "../src/checkout";
import { GitCliRepository, type GitRepository } from "../src/git";
import type { GitHubPlatform } from "../src/github";
import type { PullRequest, StackChange } from "../src/model";
import type { Reporter } from "../src/reporter";
import { FileStateStore } from "../src/state";
import { syncStack, type SyncOptions, type SyncResult } from "../src/sync";
import { test } from "./fixtures/temp-dir";

describe("stack sync integration", () => {
  test("does not push when every remote branch already matches", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const commands: string[][] = [];
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner((command) => commands.push([...command])),
    );
    const github = new FakeGitHub();
    const options = {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
    } as const;

    sync(repository, github, {
      ...options,
      reporter: new RecordingReporter(),
    });
    commands.length = 0;
    const reporter = new RecordingReporter();

    const repeated = sync(repository, github, { ...options, reporter });

    expect(repeated.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(
      commands.filter(
        (command) => command[0] === "git" && command[1] === "push",
      ),
    ).toEqual([]);
    expect(reporter.messages).toContain("All 2 remote branches already match");
  });

  test("pushes only branches whose commit OIDs changed", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const commands: string[][] = [];
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner((command) => commands.push([...command])),
    );
    const github = new FakeGitHub();
    const options = {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
    } as const;
    const submitted = sync(repository, github, {
      ...options,
      reporter: new RecordingReporter(),
    });

    writeFileSync(join(fixture.worktree, "second.txt"), "amended\n");
    git(fixture.worktree, "add", "second.txt");
    git(fixture.worktree, "commit", "--amend", "--no-edit");
    commands.length = 0;
    const reporter = new RecordingReporter();

    const updated = sync(repository, github, { ...options, reporter });
    const pushCommand = commands.find(
      (command) => command[0] === "git" && command[1] === "push",
    );

    expect(updated.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "unchanged",
      "updated",
    ]);
    expect(pushCommand).toContain(
      `${updated.changes[1]!.oid}:refs/heads/${updated.changes[1]!.remoteBranch}`,
    );
    expect(
      pushCommand?.some((argument) =>
        argument.endsWith(submitted.changes[0]!.remoteBranch),
      ),
    ).toBe(false);
    expect(reporter.messages).toContain("Updating 1 of 2 remote branches");
  });

  test("preserves staged, unstaged, and untracked changes", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();

    writeFileSync(join(fixture.worktree, "first.txt"), "unstaged\n");
    writeFileSync(join(fixture.worktree, "staged.txt"), "staged\n");
    git(fixture.worktree, "add", "staged.txt");
    writeFileSync(join(fixture.worktree, "untracked.txt"), "untracked\n");
    const statusBefore = git(
      fixture.worktree,
      "status",
      "--porcelain=v1",
    ).stdout;

    const result = sync(repository, github, {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    });

    expect(result.rewritten).toBe(true);
    expect(git(fixture.worktree, "status", "--porcelain=v1").stdout).toBe(
      statusBefore,
    );
  });

  for (const [position, index] of [
    ["bottom", 0],
    ["middle", 1],
    ["top", 2],
  ] as const) {
    test(`removes an omitted ${position} pull request from the stack`, ({
      temporaryDirectory,
    }) => {
      const fixture = createRepository(temporaryDirectory);
      const github = new FakeGitHub();
      const reporter = new RecordingReporter();
      const repository = new GitCliRepository(
        fixture.worktree,
        new NodeCommandRunner(),
      );
      const options = {
        base: "main",
        remote: "origin",
        draft: false,
        dryRun: false,
        reporter,
      } as const;

      writeFileSync(join(fixture.worktree, "third.txt"), "third\n");
      git(fixture.worktree, "add", "third.txt");
      git(fixture.worktree, "commit", "-m", "Third change");
      const submitted = sync(repository, github, options);
      const surviving = submitted.changes.filter(
        (_change, changeIndex) => changeIndex !== index,
      );

      git(fixture.worktree, "switch", "--detach", "main");
      git(
        fixture.worktree,
        "cherry-pick",
        ...surviving.map((change) => change.oid),
      );
      git(fixture.worktree, "branch", "-f", "feature", "HEAD");
      git(fixture.worktree, "switch", "feature");

      const updated = sync(repository, github, options);

      expect(updated.changes.map((change) => change.id)).toEqual(
        surviving.map((change) => change.id),
      );
      expect(
        updated.changes.map((change) => change.pullRequest?.number),
      ).toEqual(surviving.map((change) => change.pullRequest?.number));
      expect(github.unstackCalls).toEqual([7]);
      expect(github.linkCalls.at(-1)).toEqual(
        surviving.map((change) => change.pullRequest!.number),
      );
      expect(
        github.prs.get(submitted.changes[index]!.remoteBranch)?.state,
      ).toBe("CLOSED");
      expect(
        updated.outcomes
          .filter((outcome) => outcome.outcome === "closed")
          .map((outcome) => outcome.pullRequest.number),
      ).toEqual([submitted.changes[index]!.pullRequest!.number]);
      expect(
        new FileStateStore(repository.statePath()).read().stacks[0]!.changes,
      ).toEqual(
        surviving.map((change) => ({
          id: change.id,
          remoteBranch: change.remoteBranch,
          pullRequest: change.pullRequest!.number,
          url: change.pullRequest!.url,
        })),
      );
      expect(reporter.messages).toContain(
        "Rebuilding stack #7 to remove pull requests",
      );
    });
  }

  test("turns one surviving pull request into an ordinary pull request", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );
    const options = {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    } as const;
    const submitted = sync(repository, github, options);
    const survivor = submitted.changes[1]!;

    git(fixture.worktree, "switch", "--detach", "main");
    git(fixture.worktree, "cherry-pick", survivor.oid);
    git(fixture.worktree, "branch", "-f", "feature", "HEAD");
    git(fixture.worktree, "switch", "feature");

    const updated = sync(repository, github, options);
    const stored = new FileStateStore(repository.statePath()).read().stacks[0]!;

    expect(updated.changes[0]!.id).toBe(survivor.id);
    expect(github.unstackCalls).toEqual([7]);
    expect(github.baseEditCalls).toEqual([
      { pullRequest: survivor.pullRequest!.number, base: "main" },
    ]);
    expect(github.linkCalls).toHaveLength(1);
    expect(github.prs.get(submitted.changes[0]!.remoteBranch)?.state).toBe(
      "CLOSED",
    );
    expect(stored.stackNumber).toBeUndefined();
    expect(stored.changes).toHaveLength(1);
  });

  test("rebuilds reordered pull requests without changing their identities", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );
    const options = {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    } as const;
    const submitted = sync(repository, github, options);

    git(fixture.worktree, "switch", "--detach", "main");
    git(
      fixture.worktree,
      "cherry-pick",
      ...[...submitted.changes].reverse().map((change) => change.oid),
    );
    git(fixture.worktree, "branch", "-f", "feature", "HEAD");
    git(fixture.worktree, "switch", "feature");

    const reordered = sync(repository, github, options);

    expect(reordered.changes.map((change) => change.id)).toEqual(
      [...submitted.changes].reverse().map((change) => change.id),
    );
    expect(
      reordered.changes.map((change) => change.pullRequest?.number),
    ).toEqual(
      [...submitted.changes]
        .reverse()
        .map((change) => change.pullRequest?.number),
    );
    expect(github.unstackCalls).toEqual([7]);
    expect(github.baseEditCalls).toEqual(
      submitted.changes.map((change) => ({
        pullRequest: change.pullRequest!.number,
        base: "main",
      })),
    );
    expect(github.linkCalls.at(-1)).toEqual(
      reordered.changes.map((change) => change.pullRequest!.number),
    );
    expect(reporter.messages).toContain(
      "Rebuilding stack #7 to reorder pull requests",
    );
  });

  test("inserts a new change below submitted pull requests", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );
    const options = {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    } as const;

    const submitted = sync(repository, github, options);
    git(fixture.worktree, "switch", "--detach", "main");
    writeFileSync(join(fixture.worktree, "inserted.txt"), "inserted\n");
    git(fixture.worktree, "add", "inserted.txt");
    git(fixture.worktree, "commit", "-m", "Inserted change");
    git(
      fixture.worktree,
      "cherry-pick",
      ...submitted.changes.map((change) => change.oid),
    );
    git(fixture.worktree, "branch", "-f", "feature", "HEAD");
    git(fixture.worktree, "switch", "feature");

    const updated = sync(repository, github, options);

    expect(updated.changes).toHaveLength(3);
    expect(updated.changes[0]!.subject).toBe("Inserted change");
    expect(updated.changes.slice(1).map((change) => change.id)).toEqual(
      submitted.changes.map((change) => change.id),
    );
    expect(
      updated.changes.slice(1).map((change) => change.pullRequest?.number),
    ).toEqual(submitted.changes.map((change) => change.pullRequest?.number));
    expect(github.linkCalls.at(-1)).toEqual(
      updated.changes.map((change) => change.pullRequest!.number),
    );
    expect(github.unstackCalls).toEqual([7]);
    expect(reporter.messages).toContain(
      "Rebuilding stack #7 to insert pull requests",
    );
  });

  test("publishes remote-only branches and keeps PR identity after amend", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );

    const first = sync(repository, github, {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    });

    expect(first.rewritten).toBe(true);
    expect(first.changes).toHaveLength(2);
    expect(
      first.changes.every((change) =>
        change.remoteBranch.startsWith("bstack/test-user/"),
      ),
    ).toBe(true);
    expect(first.changes.every((change) => !change.pullRequest?.isDraft)).toBe(
      true,
    );
    expect(first.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "created",
      "created",
    ]);
    expect(
      git(fixture.worktree, "branch", "--format=%(refname:short)")
        .stdout.trim()
        .split("\n"),
    ).toEqual(["feature", "main"]);
    expect(
      git(
        fixture.remote,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/bstack",
      )
        .stdout.trim()
        .split("\n"),
    ).toHaveLength(2);
    expect(
      git(fixture.worktree, "log", "-2", "--format=%B").stdout.match(
        /bstack-id:/g,
      ),
    ).toHaveLength(2);
    expect(github.linkCalls).toHaveLength(1);
    expect(github.createCalls).toEqual([
      {
        subject: "First change",
        base: "main",
        draft: false,
      },
      {
        subject: "Second change",
        base: first.changes[0]!.remoteBranch,
        draft: false,
      },
    ]);
    expect(github.linkCalls[0]).toEqual(
      first.changes.map((change) => change.pullRequest!.number),
    );
    expect(reporter.messages).toContain(
      "Linking 2 pull requests as a native GitHub stack",
    );
    expect(
      reporter.messages.some((message) => message.startsWith("PR #")),
    ).toBe(true);

    checkoutStack(
      { repository, github, reporter },
      {
        reference: String(first.changes[0]!.pullRequest!.number),
        base: undefined,
        remote: "origin",
        sameBase: false,
      },
    );
    expect(
      gitAllowFailure(fixture.worktree, "symbolic-ref", "--quiet", "HEAD")
        .exitCode,
    ).not.toBe(0);
    expect(git(fixture.worktree, "rev-parse", "HEAD").stdout.trim()).toBe(
      first.changes[0]!.oid,
    );
    const checkedOutPrefix = sync(repository, github, {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    });
    expect(checkedOutPrefix.changes).toHaveLength(1);
    expect(checkedOutPrefix.outcomes[0]!.outcome).toBe("unchanged");
    expect(reporter.messages).toContain(
      "Updating this down-stack prefix while preserving higher pull requests",
    );
    git(fixture.worktree, "switch", "feature");

    writeFileSync(join(fixture.worktree, "second.txt"), "changed again\n");
    git(fixture.worktree, "add", "second.txt");
    git(fixture.worktree, "commit", "--amend", "--no-edit");

    const second = sync(repository, github, {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    });

    expect(second.rewritten).toBe(false);
    expect(second.changes.map((change) => change.id)).toEqual(
      first.changes.map((change) => change.id),
    );
    expect(second.changes.map((change) => change.pullRequest?.number)).toEqual(
      first.changes.map((change) => change.pullRequest?.number),
    );
    expect(second.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "unchanged",
      "updated",
    ]);
    expect(github.linkCalls).toHaveLength(2);

    const firstCommit = git(
      fixture.worktree,
      "rev-list",
      "--reverse",
      "main..feature",
    )
      .stdout.trim()
      .split("\n")[0]!;
    const firstPr = second.changes[0]!.pullRequest!;
    github.prs.set(second.changes[0]!.remoteBranch, {
      ...firstPr,
      state: "MERGED",
    });
    git(fixture.worktree, "branch", "-f", "main", firstCommit);
    git(fixture.worktree, "push", "origin", "main");
    git(fixture.worktree, "rebase", "--onto", "main", firstCommit, "feature");

    const afterMerge = sync(repository, github, {
      base: "main",
      remote: "origin",
      draft: false,
      dryRun: false,
      reporter,
    });

    expect(afterMerge.changes).toHaveLength(1);
    expect(afterMerge.changes[0]!.id).toBe(second.changes[1]!.id);
    expect(github.linkCalls).toHaveLength(2);
  });
});

class RecordingReporter implements Reporter {
  readonly messages: string[] = [];

  progress(message: string) {
    this.messages.push(message);
  }
}

class FakeGitHub implements GitHubPlatform {
  readonly prs = new Map<string, PullRequest>();
  readonly linkCalls: number[][] = [];
  readonly createCalls: Array<{
    subject: string;
    base: string;
    draft: boolean;
  }> = [];
  readonly unstackCalls: number[] = [];
  readonly baseEditCalls: Array<{ pullRequest: number; base: string }> = [];
  private nextPr = 100;

  assertReady() {}

  currentUserLogin() {
    return "test-user";
  }

  defaultBranch() {
    return "main";
  }

  pullRequestForBranch(branch: string) {
    return this.prs.get(branch);
  }

  pullRequest(number: number) {
    const pr = [...this.prs.values()].find(
      (candidate) => candidate.number === number,
    );
    if (!pr) {
      throw new Error(`Missing fake PR ${number}`);
    }
    return pr;
  }

  createPullRequest(change: StackChange, base: string, draft: boolean) {
    this.createCalls.push({ subject: change.subject, base, draft });

    return this.create(change, draft);
  }

  linkStack(
    pullRequests: readonly number[],
    _base: string,
    _remote: string,
    _draft: boolean,
  ) {
    this.linkCalls.push([...pullRequests]);
  }

  appendToStack(
    _stackNumber: number,
    pullRequests: readonly number[],
    remote: string,
    draft: boolean,
  ) {
    this.linkStack(pullRequests, "", remote, draft);
  }

  unstack(stackNumber: number) {
    this.unstackCalls.push(stackNumber);
  }

  closePullRequest(pr: PullRequest) {
    const entry = [...this.prs.entries()].find(
      ([, candidate]) => candidate.number === pr.number,
    );
    if (!entry) {
      throw new Error(`Missing fake PR ${pr.number}`);
    }
    this.prs.set(entry[0], {
      ...entry[1],
      state: "CLOSED",
    });
  }

  editPullRequestBase(pr: PullRequest, base: string) {
    this.baseEditCalls.push({ pullRequest: pr.number, base });
  }

  editPullRequest(pr: PullRequest, change: StackChange) {
    const current = this.prs.get(change.remoteBranch);
    if (current) {
      this.prs.set(change.remoteBranch, {
        ...current,
        title: change.subject,
        body: change.body,
      });
    }
  }

  stackNumberForPullRequest() {
    return 7;
  }

  pullRequestHead(reference: string) {
    const pr = this.pullRequest(Number(reference));
    const entry = [...this.prs.entries()].find(
      ([, candidate]) => candidate.number === pr.number,
    );
    if (!entry) {
      throw new Error(`Missing branch for fake PR ${reference}`);
    }
    return entry[0];
  }

  checkoutPullRequest() {
    throw new Error("Unexpected checkout delegation");
  }

  private create(change: StackChange, draft: boolean) {
    const pr = {
      number: this.nextPr++,
      url: `https://example.test/pull/${this.nextPr}`,
      state: "OPEN" as const,
      title: change.subject,
      body: change.body,
      isDraft: draft,
    };
    this.prs.set(change.remoteBranch, pr);
    return pr;
  }
}

function sync(
  repository: GitRepository,
  github: GitHubPlatform,
  options: SyncOptions & { reporter: Reporter },
): SyncResult {
  const { reporter, ...syncOptions } = options;

  return syncStack(
    {
      repository,
      github,
      stateStore: new FileStateStore(repository.statePath()),
      reporter,
    },
    syncOptions,
  );
}

function createRepository(root: string) {
  const remote = join(root, "origin.git");
  const worktree = join(root, "worktree");
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", worktree);
  git(worktree, "config", "user.name", "bstack Test");
  git(worktree, "config", "user.email", "bstack@example.test");
  writeFileSync(join(worktree, "base.txt"), "base\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "Base");
  git(worktree, "remote", "add", "origin", remote);
  git(worktree, "push", "-u", "origin", "main");
  git(worktree, "switch", "-c", "feature");
  writeFileSync(join(worktree, "first.txt"), "first\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "First change");
  writeFileSync(join(worktree, "second.txt"), "second\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "Second change");
  return { worktree, remote };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return { stdout: result.stdout, exitCode: result.status };
}

function gitAllowFailure(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return { stdout: result.stdout, exitCode: result.status ?? 1 };
}
