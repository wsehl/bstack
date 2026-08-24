import { describe, expect, test } from "vitest";
import type { PullRequest, StackChange } from "../src/model";
import { formatSyncResult } from "../src/output";
import type { SyncOutcome, SyncResult } from "../src/sync";

describe("sync output", () => {
  test("shows every pull request outcome", () => {
    const created = change(
      "111111111111",
      "feat(compiler): implement constant folding for unary minus (#33140)",
      "created",
    );
    const updated = change(
      "222222222222",
      "fix(devtools): clear highlight when mouse leaves DevTools panel (#36177)",
      "updated",
    );
    const unchanged = change(
      "333333333333",
      "test(eslint): create eslint test fixtures (#32396)",
      "unchanged",
    );
    const closed = pullRequest(
      14,
      "refactor(eslint-plugin-react-hooks): move rules to `rules` folder (#32411)",
    );
    const changes = [created, updated, unchanged];
    const outcomes: SyncOutcome[] = [
      currentOutcome("created", created, 11),
      currentOutcome("updated", updated, 12),
      currentOutcome("unchanged", unchanged, 13),
      {
        outcome: "closed",
        pullRequest: closed,
      },
    ];

    expect(formatSyncResult(result(changes, outcomes), false))
      .toMatchInlineSnapshot(`
      "Synced 3-commit stack against main:
        created   #11  feat(compiler): implement constant folding for unary minus (#33140) https://example.test/pull/11
        updated   #12  fix(devtools): clear highlight when mouse leaves DevTools panel (#36177) https://example.test/pull/12
        unchanged #13  test(eslint): create eslint test fixtures (#32396) https://example.test/pull/13
        closed    #14  refactor(eslint-plugin-react-hooks): move rules to \`rules\` folder (#32411) https://example.test/pull/14"
    `);
  });

  test("shows local changes without outcomes during dry run", () => {
    const preview = change(
      "abcdef012345",
      "docs: remove stale parentType param from validateChildKeys JSDoc (#36928)",
      "preview",
    );

    expect(formatSyncResult(result([preview], []), true))
      .toMatchInlineSnapshot(`
      "Would sync 1 change against main:
        abcdef01  docs: remove stale parentType param from validateChildKeys JSDoc (#36928)"
    `);
  });
});

function result(changes: StackChange[], outcomes: SyncOutcome[]): SyncResult {
  return {
    base: "main",
    remote: "origin",
    rewritten: false,
    changes,
    outcomes,
  };
}

function currentOutcome(
  outcome: "created" | "updated" | "unchanged",
  current: StackChange,
  pullRequestNumber: number,
): SyncOutcome {
  return {
    outcome,
    change: current,
    pullRequest: pullRequest(pullRequestNumber, current.subject),
  };
}

function change(oid: string, subject: string, id: string): StackChange {
  return {
    id,
    oid,
    subject,
    body: "",
    remoteBranch: `bstack/test-user/${id}`,
  };
}

function pullRequest(number: number, title: string): PullRequest {
  return {
    number,
    url: `https://example.test/pull/${number}`,
    state: "OPEN",
    title,
    body: "",
    isDraft: false,
  };
}
