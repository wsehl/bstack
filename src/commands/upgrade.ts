import { formatCommand, type ProcessRunner } from "../process-runner";
import type { Reporter } from "../reporter";

export type PackageManager = "npm" | "pnpm" | "bun" | "yarn";

export type UpgradeOptions = Record<string, never>;

export type UpgradeResult = {
  packageManager: PackageManager;
  command: readonly string[];
  output: string;
};

// Object key order defines the detection order.
const packageManagers: Record<
  PackageManager,
  { list: readonly string[]; install: readonly string[] }
> = {
  npm: {
    list: ["npm", "ls", "-g", "--depth=0"],
    install: ["npm", "install", "-g", "bstack@latest"],
  },
  yarn: {
    list: ["yarn", "global", "list"],
    install: ["yarn", "global", "add", "bstack@latest"],
  },
  pnpm: {
    list: ["pnpm", "ls", "-g", "--depth=0"],
    install: ["pnpm", "add", "-g", "bstack@latest"],
  },
  bun: {
    list: ["bun", "pm", "ls", "-g"],
    install: ["bun", "add", "-g", "bstack@latest"],
  },
};

export class UpgradeCommand {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly reporter: Reporter,
    private readonly execPath: string = process.execPath,
  ) {}

  run(): UpgradeResult {
    const packageManager = this.detectPackageManager();
    const command = packageManagers[packageManager].install;

    this.reporter.progress(
      `Updating bstack via \`${formatCommand(command)}\`...`,
    );

    const result = this.runner.run(command, { cwd: process.cwd() });

    return {
      packageManager,
      command,
      output: [result.stdout, result.stderr]
        .flatMap((text) => {
          const trimmed = text.trim();

          return trimmed ? [trimmed] : [];
        })
        .join("\n"),
    };
  }

  private detectPackageManager(): PackageManager {
    // A package manager whose own runtime is running bstack (bun and pnpm
    // shim the node binary) is the likeliest owner, so check it first.
    // SAFETY: packageManagers is declared as a complete Record for PackageManager.
    const order = (Object.keys(packageManagers) as PackageManager[]).sort(
      (a, b) => {
        const aMatch = this.execPath.includes(a);
        const bMatch = this.execPath.includes(b);

        if (aMatch !== bMatch) {
          return aMatch ? -1 : 1;
        }

        // "pnpm" contains "npm", so the longer name is the more specific match.
        return aMatch ? b.length - a.length : 0;
      },
    );

    for (const name of order) {
      const result = this.runner.run(packageManagers[name].list, {
        cwd: process.cwd(),
        allowFailure: true,
      });

      if (result.stdout.includes("bstack")) {
        return name;
      }
    }

    return "npm";
  }
}

export function formatUpgradeResult(result: UpgradeResult): string {
  const success = "Update ran successfully! Please restart bstack.";

  if (!result.output) {
    return success;
  }

  return `${result.output}\n${success}`;
}
