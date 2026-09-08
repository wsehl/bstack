#!/usr/bin/env node

import pkg from "../package.json";
import { formatHelp, parseCli } from "./cli-options";
import { CheckoutCommand } from "./commands/checkout";
import { formatSyncResult, SyncCommand } from "./commands/sync";
import { GitCliRepository } from "./git";
import { GitHubCliPlatform } from "./github";
import { NodeProcessRunner } from "./process-runner";
import { ConsoleReporter } from "./reporter";
import { FileStateStore } from "./state";

function main() {
  const request = parseCli(process.argv.slice(2));

  if (request.command === "help") {
    console.log(formatHelp(request.topic));
    return;
  }

  if (request.command === "version") {
    console.log(pkg.version);
    return;
  }

  const cwd = process.cwd();

  const reporter = new ConsoleReporter();
  const runner = new NodeProcessRunner(
    request.verbose ? (invocation) => reporter.command(invocation) : undefined,
  );
  const repository = new GitCliRepository(cwd, runner);
  const github = new GitHubCliPlatform(cwd, runner);

  if (request.command === "checkout") {
    const { reference } = request.options;
    const checkout = new CheckoutCommand(repository, github, reporter);

    const result = checkout.run(request.options);

    console.log(
      result.delegated
        ? `Checked out pull request ${reference}`
        : `Checked out ${result.headRef} from pull request ${reference}`,
    );

    return;
  }

  const stateStore = new FileStateStore(repository.statePath());
  const sync = new SyncCommand(repository, github, reporter, stateStore);
  const result = sync.run(request.options);

  console.log(formatSyncResult(result, request.options.dryRun));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bstack: ${message}`);
  process.exitCode = 1;
}
