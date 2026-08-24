import { fromPartial } from "@total-typescript/shoehorn";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { checkoutStack } from "../src/checkout";
import { NodeCommandRunner } from "../src/command";
import { GitCliRepository } from "../src/git";
import type { GitHubPlatform } from "../src/github";
import type { Reporter } from "../src/reporter";
import { test } from "./fixtures/temp-dir";

describe("stack checkout integration", () => {
  test("fetches a bstack branch and checks it out in detached HEAD state", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const reporter = new RecordingReporter();
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );

    const result = checkoutStack(
      {
        repository,
        github: fromPartial<GitHubPlatform>(
          new CheckoutGitHub(fixture.headRef),
        ),
        reporter,
      },
      {
        reference: "42",
        base: undefined,
        remote: "origin",
        sameBase: false,
      },
    );

    expect(result).toEqual({
      headRef: fixture.headRef,
      delegated: false,
    });
    expect(git(fixture.worktree, "rev-parse", "HEAD").stdout.trim()).toBe(
      fixture.targetOid,
    );
    expect(
      gitAllowFailure(
        fixture.worktree,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ).exitCode,
    ).not.toBe(0);
    expect(reporter.messages).toContain(
      `Checking out origin/${fixture.headRef} in detached HEAD state`,
    );
  });

  test("refuses same-base checkout when the remote branch has an older base", ({
    temporaryDirectory,
  }) => {
    const fixture = createRepository(temporaryDirectory);
    const repository = new GitCliRepository(
      fixture.worktree,
      new NodeCommandRunner(),
    );

    expect(() =>
      checkoutStack(
        {
          repository,
          github: fromPartial<GitHubPlatform>(
            new CheckoutGitHub(fixture.headRef),
          ),
          reporter: new RecordingReporter(),
        },
        {
          reference: "42",
          base: "main",
          remote: "origin",
          sameBase: true,
        },
      ),
    ).toThrow(
      `Checkout would change the merge base from ${fixture.mainOid.slice(0, 8)} to ${fixture.baseOid.slice(0, 8)}`,
    );
    expect(
      git(fixture.worktree, "branch", "--show-current").stdout.trim(),
    ).toBe("main");
  });
});

class RecordingReporter implements Reporter {
  readonly messages: string[] = [];

  progress(message: string) {
    this.messages.push(message);
  }
}

class CheckoutGitHub {
  constructor(private readonly headRef: string) {}

  assertReady() {}

  defaultBranch() {
    return "main";
  }

  pullRequestHead() {
    return this.headRef;
  }

  checkoutPullRequest() {
    throw new Error("Unexpected checkout delegation");
  }
}

function createRepository(root: string) {
  const remote = join(root, "origin.git");
  const worktree = join(root, "worktree");
  const headRef = "bstack/test-user/change-id";

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", worktree);
  git(worktree, "config", "user.name", "bstack Test");
  git(worktree, "config", "user.email", "bstack@example.test");
  writeFileSync(join(worktree, "base.txt"), "base\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "test: add base fixture");
  const baseOid = git(worktree, "rev-parse", "HEAD").stdout.trim();
  git(worktree, "remote", "add", "origin", remote);
  git(worktree, "push", "-u", "origin", "main");

  git(worktree, "switch", "-c", "target");
  writeFileSync(join(worktree, "target.txt"), "target\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "feat: add target fixture");
  const targetOid = git(worktree, "rev-parse", "HEAD").stdout.trim();
  git(worktree, "push", "origin", `HEAD:refs/heads/${headRef}`);

  git(worktree, "switch", "main");
  writeFileSync(join(worktree, "main.txt"), "advanced\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "test: advance main fixture");
  const mainOid = git(worktree, "rev-parse", "HEAD").stdout.trim();
  git(worktree, "push", "origin", "main");

  return {
    worktree,
    headRef,
    baseOid,
    targetOid,
    mainOid,
  };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }

  return {
    stdout: result.stdout,
    exitCode: result.status,
  };
}

function gitAllowFailure(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  return {
    stdout: result.stdout,
    exitCode: result.status ?? 1,
  };
}
