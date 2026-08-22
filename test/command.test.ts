import { describe, expect, test } from "vitest";
import { formatCommand, NodeCommandRunner } from "../src/command";

describe("command logging", () => {
  test("reports each command before execution", () => {
    const commands: string[][] = [];
    const runner = new NodeCommandRunner((command) => {
      commands.push([...command]);
    });
    const command = [process.execPath, "-e", "process.stdout.write('ok')"];

    const result = runner.run(command, { cwd: process.cwd() });

    expect(result.stdout).toBe("ok");
    expect(commands).toEqual([command]);
  });

  test("quotes arguments that contain spaces", () => {
    expect(formatCommand(["gh", "pr", "edit", "--title", "Add API"])).toBe(
      "gh pr edit --title 'Add API'",
    );
  });
});
