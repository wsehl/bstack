import { describe, expect, test } from "vitest";

import {
  formatCommand,
  NodeProcessRunner,
  ProcessError,
} from "../src/process-runner";

describe("command logging", () => {
  test("reports each command before execution", () => {
    const commands: string[][] = [];

    const runner = new NodeProcessRunner((command) => {
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

  test("abbreviates long and multi-line arguments in failures", () => {
    const error = new ProcessError(
      ["gh", "pr", "edit", "--body", `First line\n${"x".repeat(500)}`],
      { stdout: "", stderr: "HTTP 422", exitCode: 1 },
    );

    expect(error.message).toBe(
      "gh pr edit --body 'First line…' failed with exit code 1\nHTTP 422",
    );
  });
});
