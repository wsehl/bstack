#!/usr/bin/env node

import { parseArgs } from "node:util";

import pkg from "../package.json";
import { CheckoutCommand } from "./commands/checkout";
import { formatSyncResult, SyncCommand } from "./commands/sync";
import { GitCliRepository } from "./git";
import { GitHubCliPlatform } from "./github";
import { NodeProcessRunner } from "./process-runner";
import { ConsoleReporter } from "./reporter";
import { FileStateStore } from "./state";

const help = `bstack - turn a linear commit series into a native GitHub stack of PRs

Usage:
  bstack [sync] [options]
  bstack checkout <PR-number-or-URL> [options]

Options:
  --base <branch>    Stack base; defaults to the GitHub default branch
  --remote <name>    Git remote; defaults to remote.pushDefault or origin
  --draft            Create draft PRs instead of ready-for-review PRs
  --dry-run          Inspect the stack without rewriting commits or pushing
  --verbose          Show each git and gh command before it runs
  --same-base        Refuse checkout if it would change the current merge base
  -v, --version      Show the installed version
  -h, --help         Show this help
`;

// oxlint-disable-next-line eslint/complexity -- keep CLI dispatch together for now
function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      base: { type: "string" },
      remote: { type: "string" },
      draft: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "same-base": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(help);
    return;
  }

  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const cwd = process.cwd();

  const reporter = new ConsoleReporter();
  const runner = new NodeProcessRunner(
    values.verbose ? (invocation) => reporter.command(invocation) : undefined,
  );
  const repository = new GitCliRepository(cwd, runner);
  const github = new GitHubCliPlatform(cwd, runner);

  const command = positionals[0] ?? "sync";

  if (command === "checkout") {
    const reference = positionals[1];

    if (!reference || positionals.length > 2) {
      throw new Error(`Usage: bstack checkout <PR-number-or-URL> [options]`);
    }

    const checkout = new CheckoutCommand(repository, github, reporter);

    const result = checkout.run({
      reference,
      base: values.base,
      remote: values.remote,
      sameBase: values["same-base"],
    });

    console.log(
      result.delegated
        ? `Checked out pull request ${reference}`
        : `Checked out ${result.headRef} from pull request ${reference}`,
    );

    return;
  }

  if (command === "sync" && positionals.length <= 1) {
    const stateStore = new FileStateStore(repository.statePath());

    const sync = new SyncCommand(repository, github, reporter, stateStore);

    const result = sync.run({
      base: values.base,
      remote: values.remote,
      draft: values.draft,
      dryRun: values["dry-run"],
    });

    console.log(formatSyncResult(result, values["dry-run"]));

    return;
  }

  throw new Error(`Unknown command: ${positionals.join(" ")}\n\n${help}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bstack: ${message}`);
  process.exitCode = 1;
}
