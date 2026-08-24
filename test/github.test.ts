import { describe, expect, test } from "vitest";
import type { CommandOptions, CommandRunner } from "../src/command";
import { GitHubCliPlatform } from "../src/github";
import type { PullRequest, StackChange } from "../src/model";

describe("pull request creation and stack linking", () => {
  test("creates pull requests with final metadata before linking by number", () => {
    const runner = new RecordingRunner();
    const github = new GitHubCliPlatform("/repo", runner);

    expect(github.currentUserLogin()).toBe("wsehl");
    const ready = github.createPullRequest(change, "main", false);
    github.linkStack([1, 2], "main", "origin", false);
    const draft = github.createPullRequest(change, "bstack/previous", true);
    github.linkStack([1, 2], "main", "origin", true);
    github.editPullRequestBase(pullRequest, "main");
    github.closePullRequest(pullRequest);

    expect(ready).toMatchObject({
      number: 1,
      title: change.subject,
      body: change.body,
      isDraft: false,
    });
    expect(draft.isDraft).toBe(true);

    const createCommands = runner.commands.filter((command) =>
      command.includes("repos/{owner}/{repo}/pulls"),
    );
    expect(createCommands[0]).toContain(`title=${change.subject}`);
    expect(createCommands[0]).toContain(`body=${change.body}`);
    expect(createCommands[0]).toContain("base=main");
    expect(createCommands[0]).toContain("draft=false");
    expect(createCommands[1]).toContain("base=bstack/previous");
    expect(createCommands[1]).toContain("draft=true");

    const linkCommands = runner.commands.filter(
      (command) => command[1] === "stack" && command[2] === "link",
    );
    expect(linkCommands[0]).toContain("--open");
    expect(linkCommands[1]).not.toContain("--open");
    expect(linkCommands[0]?.slice(-2)).toEqual(["1", "2"]);
    expect(runner.commands).toContainEqual([
      "gh",
      "pr",
      "edit",
      "1",
      "--base",
      "main",
    ]);
    expect(runner.commands).toContainEqual(["gh", "pr", "close", "1"]);
  });
});

const change: StackChange = {
  id: "one",
  oid: "abc",
  subject: "Add one",
  body: "",
  remoteBranch: "bstack/one",
};

const pullRequest: PullRequest = {
  number: 1,
  url: "https://example.test/pull/1",
  state: "OPEN",
  title: "Add one",
  body: "",
  isDraft: false,
};

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];

  run(command: readonly string[], _options: CommandOptions) {
    this.commands.push([...command]);
    const isCreate = command.includes("repos/{owner}/{repo}/pulls");
    const isCurrentUser = command[1] === "api" && command[2] === "user";
    return {
      stdout: isCurrentUser
        ? "wsehl\n"
        : isCreate
          ? JSON.stringify({
              number: 1,
              html_url: "https://example.test/pull/1",
              state: "open",
              title: change.subject,
              body: change.body,
              draft: command.includes("draft=true"),
            })
          : "",
      stderr: "",
      exitCode: 0,
    };
  }
}
