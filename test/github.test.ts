import { describe, expect, test } from "vitest";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/command";
import { GhPlatform } from "../src/github";
import type { Change } from "../src/model";

describe("pull request visibility", () => {
  test("creates ready pull requests by default and drafts when requested", () => {
    const runner = new RecordingRunner();
    const github = new GhPlatform("/repo", runner);

    github.createPullRequest(change, "main", false);
    github.linkStack(["bstack/one", "bstack/two"], "main", "origin", false);
    github.createPullRequest(change, "main", true);
    github.linkStack(["bstack/one", "bstack/two"], "main", "origin", true);

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
  });
});

const change: Change = {
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
    return {
      stdout: isList
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
