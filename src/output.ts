import type { SyncResult } from "./sync";

export function formatSyncResult(result: SyncResult, dryRun: boolean): string {
  const changeCount = `${result.changes.length} change${result.changes.length === 1 ? "" : "s"}`;
  const lines = [
    dryRun
      ? `Would sync ${changeCount} against ${result.base}:`
      : `Synced stack against ${result.base} (${changeCount}):`,
  ];

  if (dryRun) {
    for (const change of result.changes) {
      lines.push(`  ${change.oid.slice(0, 8)}  ${change.subject}`);
    }

    return lines.join("\n");
  }

  for (const outcome of result.outcomes) {
    if (outcome.outcome === "closed") {
      const { pullRequest } = outcome;
      lines.push(
        `  ${outcome.outcome.padEnd(9)} #${pullRequest.number}  ${pullRequest.title} ${pullRequest.url}`,
      );
      continue;
    }

    lines.push(
      `  ${outcome.outcome.padEnd(9)} #${outcome.pullRequest.number}  ${outcome.change.subject} ${outcome.pullRequest.url}`,
    );
  }

  return lines.join("\n");
}
