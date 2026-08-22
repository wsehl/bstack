import { spawnSync } from "node:child_process";

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

export type CommandLogger = (command: readonly string[]) => void;

export class NodeCommandRunner implements CommandRunner {
  constructor(private readonly logger?: CommandLogger) {}

  run(command: readonly string[], options: CommandOptions) {
    const [executable, ...args] = command;
    if (!executable) {
      throw new Error("Cannot run an empty command");
    }

    this.logger?.(command);

    const result = spawnSync(executable, args, {
      cwd: options.cwd,
      input: options.stdin,
      encoding: "utf8",
      env:
        options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
    });

    const commandResult = {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
      exitCode: result.status ?? 1,
    };

    if (commandResult.exitCode !== 0 && !options.allowFailure) {
      throw new CommandError(command, commandResult);
    }

    return commandResult;
  }
}

export function formatCommand(command: readonly string[]): string {
  return command.map(formatArgument).join(" ");
}

function formatArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(argument)) {
    return argument;
  }

  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}
