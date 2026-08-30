import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type ProcessOptions = {
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
};

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class ProcessError extends Error {
  constructor(
    readonly command: readonly string[],
    readonly result: ProcessResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(
      `${command.join(" ")} failed with exit code ${result.exitCode}${detail ? `\n${detail}` : ""}`,
    );
  }
}

export interface ProcessRunner {
  run(command: readonly string[], options: ProcessOptions): ProcessResult;
}

export type ProcessLogger = (command: readonly string[]) => void;

export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly logger?: ProcessLogger) {}

  run(command: readonly string[], options: ProcessOptions) {
    const [executable, ...args] = requireCommand(command);

    this.logger?.(command);

    const result = spawnSync(executable, args, {
      cwd: options.cwd,
      input: options.stdin,
      encoding: "utf8",
      env: mergeEnvironment(options.env),
    });
    const commandResult = normalizeResult(result);

    if (commandResult.exitCode !== 0 && !options.allowFailure) {
      throw new ProcessError(command, commandResult);
    }

    return commandResult;
  }
}

function requireCommand(command: readonly string[]): [string, ...string[]] {
  const [executable, ...args] = command;

  if (!executable) {
    throw new Error("Cannot run an empty command");
  }

  return [executable, ...args];
}

function mergeEnvironment(
  environment: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (environment === undefined) {
    return process.env;
  }

  return { ...process.env, ...environment };
}

function normalizeResult(result: SpawnSyncReturns<string>): ProcessResult {
  const stderr = result.stderr ?? result.error?.message ?? "";

  return {
    stdout: result.stdout ?? "",
    stderr,
    exitCode: result.status ?? 1,
  };
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
