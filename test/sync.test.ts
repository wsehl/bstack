import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner } from "../src/command";
import { checkoutStack } from "../src/checkout";
import { GitRepository } from "../src/git";
import type { GitHubPlatform } from "../src/github";
import type { Change, PullRequest } from "../src/model";
import type { Reporter } from "../src/reporter";
import { syncStack } from "../src/sync";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stack sync", () => {
  test("inserts a new change below submitted pull requests", () => {
    const fixture = createRepository();
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();
    const repository = new GitRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );
    const options = {
      base: "main",
      remote: "origin",
      open: false,
      dryRun: false,
      reporter,
    } as const;

    const submitted = syncStack(repository, github, options);
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

    const updated = syncStack(repository, github, options);

    expect(updated.changes).toHaveLength(3);
    expect(updated.changes[0]!.subject).toBe("Inserted change");
    expect(updated.changes.slice(1).map((change) => change.id)).toEqual(
      submitted.changes.map((change) => change.id),
    );
    expect(
      updated.changes.slice(1).map((change) => change.pullRequest?.number),
    ).toEqual(submitted.changes.map((change) => change.pullRequest?.number));
    expect(github.linkCalls.at(-1)).toEqual(
      updated.changes.map((change) => change.remoteBranch),
    );
  });

  test("publishes remote-only branches and keeps PR identity after amend", () => {
    const fixture = createRepository();
    const github = new FakeGitHub();
    const reporter = new RecordingReporter();
    const repository = new GitRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );

    const first = syncStack(repository, github, {
      base: "main",
      remote: "origin",
      open: false,
      dryRun: false,
      reporter,
    });

    expect(first.rewritten).toBe(true);
    expect(first.changes).toHaveLength(2);
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
        /Bstack-Id:/g,
      ),
    ).toHaveLength(2);
    expect(github.linkCalls).toHaveLength(1);
    expect(reporter.messages).toContain(
      "Linking 2 pull requests as a native GitHub stack",
    );
    expect(
      reporter.messages.some((message) => message.startsWith("PR #")),
    ).toBe(true);

    checkoutStack(repository, github, {
      reference: String(first.changes[0]!.pullRequest!.number),
      base: undefined,
      remote: "origin",
      sameBase: false,
      reporter,
    });
    expect(
      gitAllowFailure(fixture.worktree, "symbolic-ref", "--quiet", "HEAD")
        .exitCode,
    ).not.toBe(0);
    expect(git(fixture.worktree, "rev-parse", "HEAD").stdout.trim()).toBe(
      first.changes[0]!.oid,
    );
    const checkedOutPrefix = syncStack(repository, github, {
      base: "main",
      remote: "origin",
      open: false,
      dryRun: false,
      reporter,
    });
    expect(checkedOutPrefix.changes).toHaveLength(1);
    expect(reporter.messages).toContain(
      "Updating this down-stack prefix while preserving higher pull requests",
    );
    git(fixture.worktree, "switch", "feature");

    writeFileSync(join(fixture.worktree, "second.txt"), "changed again\n");
    git(fixture.worktree, "add", "second.txt");
    git(fixture.worktree, "commit", "--amend", "--no-edit");

    const second = syncStack(repository, github, {
      base: "main",
      remote: "origin",
      open: false,
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

    const afterMerge = syncStack(repository, github, {
      base: "main",
      remote: "origin",
      open: false,
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

  progress(message: string): void {
    this.messages.push(message);
  }
}

class FakeGitHub implements GitHubPlatform {
  readonly prs = new Map<string, PullRequest>();
  readonly linkCalls: string[][] = [];
  private nextPr = 100;

  assertReady(): void {}

  defaultBranch(): string {
    return "main";
  }

  pullRequestForBranch(branch: string): PullRequest | undefined {
    return this.prs.get(branch);
  }

  pullRequest(number: number): PullRequest {
    const pr = [...this.prs.values()].find(
      (candidate) => candidate.number === number,
    );
    if (!pr) throw new Error(`Missing fake PR ${number}`);
    return pr;
  }

  createPullRequest(change: Change): PullRequest {
    return this.create(change);
  }

  linkStack(branches: readonly string[]): void {
    this.linkCalls.push([...branches]);
    for (const branch of branches) {
      if (!this.prs.has(branch)) {
        this.create({
          id: branch,
          oid: "",
          subject: branch,
          body: "",
          remoteBranch: branch,
        });
      }
    }
  }

  appendToStack(_stackNumber: number, branches: readonly string[]): void {
    this.linkStack(branches);
  }

  editPullRequest(pr: PullRequest, change: Change): void {
    const current = this.prs.get(change.remoteBranch);
    if (current)
      this.prs.set(change.remoteBranch, {
        ...current,
        title: change.subject,
        body: change.body,
      });
  }

  stackNumberForPullRequest(): number {
    return 7;
  }

  pullRequestHead(reference: string): string {
    const pr = this.pullRequest(Number(reference));
    const entry = [...this.prs.entries()].find(
      ([, candidate]) => candidate.number === pr.number,
    );
    if (!entry) throw new Error(`Missing branch for fake PR ${reference}`);
    return entry[0];
  }

  checkoutPullRequest(): void {
    throw new Error("Unexpected checkout delegation");
  }

  private create(change: Change): PullRequest {
    const pr = {
      number: this.nextPr++,
      url: `https://example.test/pull/${this.nextPr}`,
      state: "OPEN" as const,
      title: change.subject,
      body: change.body,
      isDraft: true,
    };
    this.prs.set(change.remoteBranch, pr);
    return pr;
  }
}

function createRepository(): { worktree: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), "bstack-test-"));
  temporaryDirectories.push(root);
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

function git(
  cwd: string,
  ...args: string[]
): { stdout: string; exitCode: number } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return { stdout: result.stdout, exitCode: result.status };
}

function gitAllowFailure(
  cwd: string,
  ...args: string[]
): { stdout: string; exitCode: number } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return { stdout: result.stdout, exitCode: result.status ?? 1 };
}
