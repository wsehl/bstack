import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { GitCliRepository } from "../src/git";
import { NodeProcessRunner } from "../src/process-runner";
import { test } from "./fixtures/temp-dir";

describe("git repository", () => {
  test("shares the state path across linked worktrees", ({
    temporaryDirectory,
  }) => {
    const root = realpathSync(temporaryDirectory);
    const main = join(root, "main");
    const linked = join(root, "linked");
    git(root, "init", "-b", "main", main);
    git(
      main,
      "-c",
      "user.name=bstack Test",
      "-c",
      "user.email=bstack@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "Base",
    );
    git(main, "worktree", "add", "-b", "linked", linked);

    const runner = new NodeProcessRunner();
    const expected = join(main, ".git", "bstack", "state.json");

    expect(new GitCliRepository(main, runner).statePath()).toBe(expected);
    expect(new GitCliRepository(linked, runner).statePath()).toBe(expected);
  });
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}
