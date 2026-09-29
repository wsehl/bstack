import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { formatCommand, type ProcessRunner } from "../process-runner";
import type { Reporter } from "../reporter";

export type PackageManager = "npm" | "pnpm" | "bun" | "yarn";

export type InstallMethod = PackageManager | "binary";

export type UpgradeOptions = Record<string, never>;

export type UpgradeResult = {
  method: InstallMethod;
  command: readonly string[];
  output: string;
};

// How the running bstack was started.
export type Installation =
  | { kind: "binary"; path: string }
  // The entry script as invoked and with symlinks resolved. Package managers
  // link it differently: pnpm runs it from its global dir through a shell shim
  // while npm and yarn symlink it into their bin dir.
  | { kind: "script"; paths: readonly string[] };

export const installScriptUrl =
  "https://raw.githubusercontent.com/wsehl/bstack/main/install.sh";

const packageManagers: Record<
  PackageManager,
  { globalDir: readonly string[]; install: readonly string[] }
> = {
  npm: {
    globalDir: ["npm", "root", "-g"],
    install: ["npm", "install", "-g", "bstack@latest"],
  },
  pnpm: {
    globalDir: ["pnpm", "root", "-g"],
    install: ["pnpm", "add", "-g", "bstack@latest"],
  },
  bun: {
    globalDir: ["bun", "pm", "bin", "-g"],
    install: ["bun", "add", "-g", "bstack@latest"],
  },
  yarn: {
    globalDir: ["yarn", "global", "dir"],
    install: ["yarn", "global", "add", "bstack@latest"],
  },
};

export function currentInstallation(): Installation {
  const script = process.argv[1] ?? "";

  // Bun-compiled binaries run their bundled entry from an embedded filesystem.
  if (script.startsWith("/$bunfs/")) {
    return {
      kind: "binary",
      path: process.execPath,
    };
  }

  const invoked = resolve(script);
  let resolved = invoked;

  try {
    resolved = realpathSync(invoked);
  } catch {
    // Keep the invoked path; detection reports when it matches nothing.
  }

  return {
    kind: "script",
    paths: [...new Set([invoked, resolved])],
  };
}

export class UpgradeCommand {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly reporter: Reporter,
    private readonly installation: Installation = currentInstallation(),
  ) {}

  run(): UpgradeResult {
    const {
      method,
      command,
      label = formatCommand(command),
      env,
    } = this.plan();

    this.reporter.progress(`Updating bstack via \`${label}\`...`);

    const result = this.runner.run(command, {
      cwd: process.cwd(),
      ...(env && { env }),
    });

    return {
      method,
      command,
      output: [result.stdout, result.stderr]
        .flatMap((text) => {
          const trimmed = text.trim();

          return trimmed ? [trimmed] : [];
        })
        .join("\n"),
    };
  }

  private plan(): {
    method: InstallMethod;
    command: readonly string[];
    label?: string;
    env?: Record<string, string>;
  } {
    if (this.installation.kind === "binary") {
      // Rerun the installer so binary installs and upgrades share one download
      // path. It replaces the binary in place, wherever the user put it.
      return {
        method: "binary",
        command: [
          "sh",
          "-c",
          // Fetch before piping so a failed download fails the upgrade instead
          // of feeding an empty script to sh.
          'installer=$(curl -fsSL "$0") && printf "%s\\n" "$installer" | sh',
          installScriptUrl,
        ],
        label: `curl -fsSL ${installScriptUrl} | sh`,
        env: { BSTACK_INSTALL_DIR: dirname(this.installation.path) },
      };
    }

    const method = this.detectPackageManager(this.installation.paths);

    return {
      method,
      command: packageManagers[method].install,
    };
  }

  // The owner is the package manager whose global dir holds the running
  // script. Asking whether a manager lists bstack is not enough: with several
  // global installs, upgrading one that is not first on PATH changes nothing.
  private detectPackageManager(scriptPaths: readonly string[]): PackageManager {
    // SAFETY: packageManagers is declared as a complete Record for PackageManager.
    for (const name of Object.keys(packageManagers) as PackageManager[]) {
      const result = this.runner.run(packageManagers[name].globalDir, {
        cwd: process.cwd(),
        allowFailure: true,
      });

      const globalDir = result.stdout.trim();

      if (
        result.exitCode === 0 &&
        isAbsolute(globalDir) &&
        scriptPaths.some((path) => isInside(globalDir, path))
      ) {
        return name;
      }
    }

    throw new Error(
      `Cannot tell which package manager installed bstack at ${scriptPaths[0]}. If you run bstack through npx or pnpm dlx, use bstack@latest instead; otherwise upgrade it with the tool that installed it`,
    );
  }
}

function isInside(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);

  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

export function formatUpgradeResult(result: UpgradeResult): string {
  const success = "Update ran successfully! Please restart bstack.";

  if (!result.output) {
    return success;
  }

  return `${result.output}\n${success}`;
}
