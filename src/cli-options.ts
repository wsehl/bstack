import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import type { CheckoutOptions } from "./commands/checkout";
import type { SyncOptions } from "./commands/sync";
import type { UpgradeOptions } from "./commands/upgrade";

export type CliRequest =
  | { command: "sync"; options: SyncOptions; verbose: boolean }
  | { command: "checkout"; options: CheckoutOptions; verbose: boolean }
  | { command: "upgrade"; options: UpgradeOptions; verbose: boolean }
  | { command: "help"; topic: "sync" | "checkout" | "upgrade" | undefined }
  | { command: "version" };

type OptionDefinitions = Record<
  string,
  ParseArgsOptionsConfig[string] & { description: string; argument?: string }
>;

const sharedOptions = {
  base: {
    type: "string",
    argument: "branch",
    description: "Stack base; defaults to the GitHub default branch",
  },
  remote: {
    type: "string",
    argument: "name",
    description: "Git remote; defaults to remote.pushDefault or origin",
  },
  verbose: {
    type: "boolean",
    description: "Show each git and gh command before it runs",
  },
  version: {
    type: "boolean",
    short: "v",
    description: "Show the installed version",
  },
  help: {
    type: "boolean",
    short: "h",
    description: "Show this help",
  },
} satisfies OptionDefinitions;

const syncOptions = {
  draft: {
    type: "boolean",
    description: "Create draft PRs instead of ready-for-review PRs",
  },
  "dry-run": {
    type: "boolean",
    description: "Inspect the stack without rewriting commits or pushing",
  },
} satisfies OptionDefinitions;

const checkoutOptions = {
  "same-base": {
    type: "boolean",
    description: "Refuse checkout if it would change the current merge base",
  },
} satisfies OptionDefinitions;

const usage = {
  sync: "bstack [sync] [options]",
  checkout: "bstack checkout <PR-number-or-URL> [options]",
  upgrade: "bstack upgrade",
};

export function formatHelp(topic?: "sync" | "checkout" | "upgrade"): string {
  const sections: Array<[string, OptionDefinitions]> = [];

  if (!topic || topic === "sync" || topic === "checkout") {
    sections.push(["Options", sharedOptions]);
  }

  if (!topic || topic === "sync") {
    sections.push(["Sync options", syncOptions]);
  }

  if (!topic || topic === "checkout") {
    sections.push(["Checkout options", checkoutOptions]);
  }

  const options = sections.map(([title, definitions]) => {
    const lines = Object.entries(definitions).map(([name, option]) => {
      const alias = option.short ? `-${option.short}, ` : "";
      const argument = option.argument ? ` <${option.argument}>` : "";
      return `  ${`${alias}--${name}${argument}`.padEnd(20)}${option.description}`;
    });
    return `${title}:\n${lines.join("\n")}`;
  });

  const optionLines = options.join("\n\n");

  return `bstack - turn a linear commit series into a native GitHub stack of PRs

Usage:
${(topic ? [usage[topic]] : Object.values(usage)).map((line) => `  ${line}`).join("\n")}${optionLines ? `\n\n${optionLines}` : ""}`;
}

// oxlint-disable-next-line eslint/complexity -- keep command validation and option defaults together
export function parseCli(argv: string[]): CliRequest {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...sharedOptions, ...syncOptions, ...checkoutOptions },
  });

  const command = positionals[0] ?? "sync";
  const canonical = command === "update" ? "upgrade" : command;
  if (
    canonical !== "sync" &&
    canonical !== "checkout" &&
    canonical !== "upgrade"
  ) {
    throw new Error(`Unknown command: ${command}\n\n${formatHelp()}`);
  }

  const allowedOptions =
    canonical === "upgrade"
      ? { help: sharedOptions.help, version: sharedOptions.version }
      : {
          ...sharedOptions,
          ...(canonical === "sync" ? syncOptions : checkoutOptions),
        };

  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(allowedOptions, name)) {
      throw new Error(`Option --${name} is not supported by ${canonical}`);
    }
  }

  if (values.help) {
    return { command: "help", topic: positionals[0] ? canonical : undefined };
  }

  if (values.version) {
    return { command: "version" };
  }

  const common = { base: values.base, remote: values.remote };
  const verbose = values.verbose ?? false;

  if (canonical === "upgrade") {
    if (positionals.length > 1) {
      throw new Error(`Usage: ${usage.upgrade}`);
    }

    return { command: canonical, options: {}, verbose };
  }

  if (canonical === "checkout") {
    const reference = positionals[1];
    if (!reference || positionals.length > 2) {
      throw new Error(`Usage: ${usage.checkout}`);
    }
    return {
      command: canonical,
      verbose,
      options: { ...common, reference, sameBase: values["same-base"] ?? false },
    };
  }

  if (positionals.length > 1) {
    throw new Error(`Usage: ${usage.sync}`);
  }

  return {
    command: canonical,
    verbose,
    options: {
      ...common,
      draft: values.draft ?? false,
      dryRun: values["dry-run"] ?? false,
    },
  };
}
