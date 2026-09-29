import { describe, expect, test } from "vitest";

import { installScriptUrl, UpgradeCommand } from "../src/commands/upgrade";
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

// Answers every global dir probe the way a machine with all four package
// managers would, and succeeds silently for anything else.
function fakeRunner(responses: Record<string, ProcessResult> = {}): FakeRunner {
  const globalDirs: Record<string, string> = {
    "npm root -g": "/usr/local/lib/node_modules",
    "pnpm root -g": "/home/user/.local/share/pnpm/global/v11",
    "bun pm bin -g": "/home/user/.bun/bin",
    "yarn global dir": "/home/user/.config/yarn/global",
  };

  return new FakeRunner((command) => {
    const key = command.join(" ");
    const globalDir = globalDirs[key];

    return (
      responses[key] ??
      (globalDir
        ? { stdout: `${globalDir}\n`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 })
    );
  });
}

function script(...paths: string[]) {
  return {
    kind: "script",
    paths,
  } as const;
}

describe("upgrade", () => {
  test("updates through npm when the script lives in npm's global dir", () => {
    const runner = fakeRunner({
      "npm install -g bstack@latest": {
        stdout: "",
        stderr: "changed 2 packages in 2s",
        exitCode: 0,
      },
    });

    const reporter = new FakeReporter();

    const result = new UpgradeCommand(
      runner,
      reporter,
      script(
        "/usr/local/bin/bstack",
        "/usr/local/lib/node_modules/bstack/dist/bstack.mjs",
      ),
    ).run();

    expect(result.method).toBe("npm");
    expect(result.command).toEqual(["npm", "install", "-g", "bstack@latest"]);
    expect(result.output).toBe("changed 2 packages in 2s");
    expect(runner.calls.map((call) => call.command)).toEqual([
      ["npm", "root", "-g"],
      ["npm", "install", "-g", "bstack@latest"],
    ]);
    expect(reporter.messages).toEqual([
      "Updating bstack via `npm install -g bstack@latest`...",
    ]);
  });

  test("updates through pnpm when its shim runs the script from its global dir", () => {
    const runner = fakeRunner();

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      script(
        "/home/user/.local/share/pnpm/global/v11/7f6f/node_modules/bstack/dist/bstack.mjs",
        "/home/user/.local/share/pnpm/store/v11/links/bstack/1.7.0/node_modules/bstack/dist/bstack.mjs",
      ),
    ).run();

    expect(result.method).toBe("pnpm");
    expect(result.command).toEqual(["pnpm", "add", "-g", "bstack@latest"]);
  });

  test("updates through bun when the script is linked from bun's global bin", () => {
    const result = new UpgradeCommand(
      fakeRunner(),
      new FakeReporter(),
      script(
        "/home/user/.bun/bin/bstack",
        "/home/user/.bun/install/global/node_modules/bstack/dist/bstack.mjs",
      ),
    ).run();

    expect(result.method).toBe("bun");
    expect(result.command).toEqual(["bun", "add", "-g", "bstack@latest"]);
  });

  test("updates through yarn when the script lives in yarn's global dir", () => {
    const result = new UpgradeCommand(
      fakeRunner(),
      new FakeReporter(),
      script(
        "/usr/local/bin/bstack",
        "/home/user/.config/yarn/global/node_modules/bstack/dist/bstack.mjs",
      ),
    ).run();

    expect(result.method).toBe("yarn");
    expect(result.command).toEqual(["yarn", "global", "add", "bstack@latest"]);
  });

  test("ignores failed and empty global dir probes", () => {
    const runner = fakeRunner({
      "npm root -g": { stdout: "", stderr: "", exitCode: 0 },
      "pnpm root -g": {
        stdout: "/home/user/.local/share/pnpm/global/v11",
        stderr: "command not found",
        exitCode: 127,
      },
    });

    expect(() =>
      new UpgradeCommand(
        runner,
        new FakeReporter(),
        script(
          "/home/user/.local/share/pnpm/global/v11/7f6f/node_modules/bstack/dist/bstack.mjs",
        ),
      ).run(),
    ).toThrow("Cannot tell which package manager installed bstack");
  });

  test("refuses to guess when no global dir holds the script", () => {
    const runner = fakeRunner();

    expect(() =>
      new UpgradeCommand(
        runner,
        new FakeReporter(),
        script("/home/user/.npm/_npx/1a2b/node_modules/bstack/dist/bstack.mjs"),
      ).run(),
    ).toThrow("Cannot tell which package manager installed bstack");
    expect(runner.calls.map((call) => call.command.join(" "))).toEqual([
      "npm root -g",
      "pnpm root -g",
      "bun pm bin -g",
      "yarn global dir",
    ]);
  });

  test("reruns the installer into the binary's directory", () => {
    const runner = fakeRunner();

    const result = new UpgradeCommand(runner, new FakeReporter(), {
      kind: "binary",
      path: "/home/user/.local/bin/bstack",
    }).run();

    expect(result.method).toBe("binary");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toContain(installScriptUrl);
    expect(runner.calls[0]?.options.env).toEqual({
      BSTACK_INSTALL_DIR: "/home/user/.local/bin",
    });
  });

  test("combines trimmed stdout and stderr of the install", () => {
    const runner = fakeRunner({
      "npm install -g bstack@latest": {
        stdout: "added 1 package\n",
        stderr: "1 warning\n",
        exitCode: 0,
      },
    });

    const result = new UpgradeCommand(
      runner,
      new FakeReporter(),
      script("/usr/local/lib/node_modules/bstack/dist/bstack.mjs"),
    ).run();

    expect(result.output).toBe("added 1 package\n1 warning");
  });
});
