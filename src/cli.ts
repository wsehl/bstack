#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { BunCommandRunner } from "./command";
import { checkoutStack } from "./checkout";
import { GitRepository } from "./git";
import { GhPlatform } from "./github";
import { ConsoleReporter } from "./reporter";
import { syncStack } from "./sync";

const help = `bstack - turn a linear commit series into native GitHub stacked PRs

Usage:
  bstack [sync] [options]
  bstack checkout <PR-number-or-URL> [options]

Options:
  --base <branch>    Stack trunk; defaults to the GitHub default branch
  --remote <name>    Git remote; defaults to remote.pushDefault or origin
  --open             Create PRs ready for review instead of drafts
  --dry-run          Inspect the stack without rewriting commits or pushing
  --quiet            Hide progress logs; the final summary is still printed
  --same-base        Refuse checkout if it would change the current merge base
  -h, --help         Show this help
`;

function main(): void {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      base: { type: "string" },
      remote: { type: "string" },
      open: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      "same-base": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const runner = new BunCommandRunner();
  const cwd = process.cwd();
  const repository = new GitRepository(cwd, runner);
  const github = new GhPlatform(cwd, runner);
  const reporter = new ConsoleReporter(!values.quiet);
  const command = positionals[0] ?? "sync";

  if (command === "checkout") {
    const reference = positionals[1];
    if (!reference || positionals.length > 2) {
      throw new Error(`Usage: bstack checkout <PR-number-or-URL> [options]`);
    }
    const result = checkoutStack(repository, github, {
      reference,
      base: values.base,
      remote: values.remote,
      sameBase: values["same-base"],
      reporter,
    });
    console.log(
      result.delegated
        ? `Checked out pull request ${reference}`
        : `Checked out ${result.headRef} from pull request ${reference}`,
    );
    return;
  }

  if (command !== "sync" || positionals.length > 1) {
    throw new Error(`Unknown command: ${positionals.join(" ")}\n\n${help}`);
  }

  const result = syncStack(repository, github, {
    base: values.base,
    remote: values.remote,
    open: values.open,
    dryRun: values["dry-run"],
    reporter,
  });

  console.log(
    `${values["dry-run"] ? "Would publish" : "Published"} ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} against ${result.base}:`,
  );
  for (const change of result.changes) {
    const destination = change.pullRequest ? ` ${change.pullRequest.url}` : "";
    console.log(`  ${change.oid.slice(0, 8)}  ${change.subject}${destination}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bstack: ${message}`);
  process.exitCode = 1;
}
