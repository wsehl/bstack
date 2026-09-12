import { describe, expect, test } from "vitest";

import { UpgradeCommand } from "../src/commands/upgrade";
import type { ProcessOptions, ProcessResult } from "../src/process-runner";
import type { Reporter } from "../src/reporter";

class FakeRunner {
  calls: Array<{ command: readonly string[]; options: ProcessOptions }> = [];

  constructor(
    private readonly respond: (command: readonly string[]) => ProcessResult,
  ) {}

  run(command: readonly string[], options: ProcessOptions): ProcessResult {
    this.calls.push({ command, options });

    return this.respond(command);
  }
}

class FakeReporter implements Reporter {
  messages: string[] = [];

  progress(message: string) {
    this.messages.push(message);
  }
}

function fakeRunner(responses: Record<string, ProcessResult>): FakeRunner {
  return new FakeRunner(
    (command) =>
      responses[command.join(" ")] ?? { stdout: "", stderr: "", exitCode: 0 },
  );
}

describe("upgrade", () => {
  const neutralExecPath = "/usr/local/bin/node";

  test("updates through npm when npm owns the global install", () => {
    const runner = fakeRunner({
      "npm ls -g --depth=0": {
        stdout: "├── bstack@1.5.3",
        stderr: "",
        exitCode: 0,
      },
      "npm install -g bstack@latest": {
        stdout: "",
        stderr: "changed 2 packages in 2s",
        exitCode: 0,
      },
    });

    const reporter = new FakeReporter();

    const result = new UpgradeCommand(runner, reporter, neutralExecPath).run();

    expect(result.packageManager).toBe("npm");
    expect(result.command).toEqual(["npm", "install", "-g", "bstack@latest"]);
    expect(result.output).toBe("changed 2 packages in 2s");
    expect(runner.calls.map((call) => call.command)).toEqual([
      ["npm", "ls", "-g", "--depth=0"],
      ["npm", "install", "-g", "bstack@latest"],
    ]);
    expect(reporter.messages).toEqual([
      "Updating bstack via `npm install -g bstack@latest`...",
    ]);
  });

  test("prefers the package manager running bstack before its listing", () => {
    const runner = fakeRunner({
      "npm ls -g --depth=0": {
        stdout: "├── bstack@1.5.3",
        stderr: "",
        exitCode: 0,
      },
      "pnpm ls -g --depth=0": {
        stdout: "bstack 1.5.3",
        stderr: "",
        exitCode: 0,
      },
      "pnpm add -g bstack@latest": { stdout: "", stderr: "", exitCode: 0 },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      "/home/user/Library/pnpm/nodejs/22.14.0/bin/node",
    ).run();

    expect(result.packageManager).toBe("pnpm");
    expect(result.command).toEqual(["pnpm", "add", "-g", "bstack@latest"]);
  });

  test("updates through bun when bun owns the global install", () => {
    const runner = fakeRunner({
      "bun pm ls -g": { stdout: "bstack@1.5.3", stderr: "", exitCode: 0 },
      "bun add -g bstack@latest": {
        stdout: "installed bstack@1.5.4",
        stderr: "",
        exitCode: 0,
      },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      "/home/user/.bun/bin/bun",
    ).run();

    expect(result.packageManager).toBe("bun");
    expect(result.command).toEqual(["bun", "add", "-g", "bstack@latest"]);
  });

  test("updates through yarn when yarn owns the global install", () => {
    const runner = fakeRunner({
      "yarn global list": {
        stdout: 'info "bstack@1.5.3" has binaries',
        stderr: "",
        exitCode: 0,
      },
      "yarn global add bstack@latest": {
        stdout: 'success Installed "bstack@1.5.4"',
        stderr: "",
        exitCode: 0,
      },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      neutralExecPath,
    ).run();

    expect(result.packageManager).toBe("yarn");
    expect(result.command).toEqual(["yarn", "global", "add", "bstack@latest"]);
  });

  test("falls back to npm when no listing reports bstack", () => {
    const runner = fakeRunner({
      "npm install -g bstack@latest": {
        stdout: "added 1 package",
        stderr: "",
        exitCode: 0,
      },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      neutralExecPath,
    ).run();

    expect(result.packageManager).toBe("npm");
    expect(result.command).toEqual(["npm", "install", "-g", "bstack@latest"]);
  });

  test("skips empty and failed listings until one reports bstack", () => {
    const runner = fakeRunner({
      "pnpm ls -g --depth=0": {
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
      },
      "bun pm ls -g": { stdout: "bstack@1.5.3", stderr: "", exitCode: 0 },
      "bun add -g bstack@latest": {
        stdout: "installed bstack@1.5.4",
        stderr: "",
        exitCode: 0,
      },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      neutralExecPath,
    ).run();

    expect(result.packageManager).toBe("bun");
    expect(runner.calls.map((call) => call.command.join(" "))).toEqual([
      "npm ls -g --depth=0",
      "yarn global list",
      "pnpm ls -g --depth=0",
      "bun pm ls -g",
      "bun add -g bstack@latest",
    ]);
  });

  test("combines trimmed stdout and stderr of the install", () => {
    const runner = fakeRunner({
      "npm ls -g --depth=0": {
        stdout: "├── bstack@1.5.3",
        stderr: "",
        exitCode: 0,
      },
      "npm install -g bstack@latest": {
        stdout: "added 1 package\n",
        stderr: "1 warning\n",
        exitCode: 0,
      },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      neutralExecPath,
    ).run();

    expect(result.output).toBe("added 1 package\n1 warning");
  });
});
