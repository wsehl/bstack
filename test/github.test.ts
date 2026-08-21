import { describe, expect, test } from "vitest";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/command";
import { GitHubCliPlatform } from "../src/github";
import type { StackChange } from "../src/model";

describe("pull request visibility", () => {
  test("creates ready pull requests by default and drafts when requested", () => {
    const runner = new RecordingRunner();
    const github = new GitHubCliPlatform("/repo", runner);

    expect(github.currentUserLogin()).toBe("wsehl");
    github.createPullRequest(change, "main", false);
    github.linkStack(["bstack/one", "bstack/two"], "main", "origin", false);
    github.createPullRequest(change, "main", true);
    github.linkStack(["bstack/one", "bstack/two"], "main", "origin", true);
    github.editPullRequestBase(
      {
        number: 1,
        url: "https://example.test/pull/1",
        state: "OPEN",
        title: "Add one",
        body: "",
        isDraft: false,
      },
      "main",
    );

    const createCommands = runner.commands.filter(
      (command) => command[1] === "pr" && command[2] === "create",
    );
    expect(createCommands[0]).not.toContain("--draft");
    expect(createCommands[1]).toContain("--draft");

    const linkCommands = runner.commands.filter(
      (command) => command[1] === "stack" && command[2] === "link",
    );
    expect(linkCommands[0]).toContain("--open");
    expect(linkCommands[1]).not.toContain("--open");
    expect(runner.commands).toContainEqual([
      "gh",
      "pr",
      "edit",
      "1",
      "--base",
      "main",
    ]);
  });
});

const change: StackChange = {
  id: "one",
  oid: "abc",
  subject: "Add one",
  body: "",
  remoteBranch: "bstack/one",
};

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];

  run(command: readonly string[], _options: CommandOptions): CommandResult {
    this.commands.push([...command]);
    const isList = command[1] === "pr" && command[2] === "list";
    const isCurrentUser = command[1] === "api" && command[2] === "user";
    return {
      stdout: isCurrentUser
        ? "wsehl\n"
        : isList
          ? JSON.stringify([
              {
                number: 1,
                url: "https://example.test/pull/1",
                state: "OPEN",
                title: change.subject,
                body: change.body,
                isDraft: false,
              },
            ])
          : "",
      stderr: "",
      exitCode: 0,
    };
  }
}
