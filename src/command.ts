export type CommandOptions = {
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class CommandError extends Error {
  constructor(
    readonly command: readonly string[],
    readonly result: CommandResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(
      `${command.join(" ")} failed with exit code ${result.exitCode}${detail ? `\n${detail}` : ""}`,
    );
  }
}

export interface CommandRunner {
  run(command: readonly string[], options: CommandOptions): CommandResult;
}

export class BunCommandRunner implements CommandRunner {
  run(command: readonly string[], options: CommandOptions): CommandResult {
    const [executable, ...args] = command;
    if (!executable) {
      throw new Error("Cannot run an empty command");
    }

    const result = Bun.spawnSync([executable, ...args], {
      cwd: options.cwd,
      stdin:
        options.stdin === undefined ? undefined : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env:
        options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
    });

    const commandResult = {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };

    if (commandResult.exitCode !== 0 && !options.allowFailure) {
      throw new CommandError(command, commandResult);
    }

    return commandResult;
  }
}
