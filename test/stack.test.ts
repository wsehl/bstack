import { describe, expect, test } from "vitest";
import type { PullRequest, StackChange, StoredStack } from "../src/model";
import { Stack, type StackTransitionLookups } from "../src/stack";

describe("stack transition analysis", () => {
  test("rejects an empty stack", () => {
    expect(() => Stack.fromChanges([])).toThrow(
      "A stack must contain at least one change",
    );
  });

  test.each([
    {
      name: "starts a stack without previous state",
      previous: undefined,
      changes: changes("a", "b"),
      expected: { kind: "full" },
    },
    {
      name: "appends changes to a known native stack",
      previous: stack("a", "b"),
      changes: changes("a", "b", "c"),
      expected: {
        kind: "append",
        stackNumber: 7,
        branches: ["bstack/c"],
      },
    },
    {
      name: "skips an unchanged submitted stack",
      previous: stack("a", "b"),
      changes: changes("a", "b"),
      expected: { kind: "skip" },
    },
    {
      name: "rebuilds when a change is inserted",
      previous: stack("a", "b"),
      changes: changes("x", "a", "b"),
      expected: { kind: "rebuild", stackNumber: 7, action: "insert" },
    },
    {
      name: "rebuilds when submitted changes are reordered",
      previous: stack("a", "b", "c"),
      changes: changes("c", "a", "b"),
      expected: { kind: "rebuild", stackNumber: 7, action: "reorder" },
    },
    {
      name: "removes a merged prefix without rebuilding",
      previous: stack("a", "b", "c"),
      changes: changes("b", "c"),
      states: { 1: "MERGED" },
      expected: { kind: "skip" },
    },
    {
      name: "appends after a merged prefix",
      previous: stack("a", "b"),
      changes: changes("b", "c"),
      states: { 1: "MERGED" },
      expected: {
        kind: "append",
        stackNumber: 7,
        branches: ["bstack/c"],
      },
    },
    {
      name: "collapses to one pull request",
      previous: stack("a", "b"),
      changes: changes("b"),
      states: { 1: "OPEN" },
      expected: { kind: "collapse", stackNumber: 7 },
    },
    {
      name: "rebuilds when a change is removed from the middle",
      previous: stack("a", "b", "c"),
      changes: changes("a", "c"),
      expected: { kind: "rebuild", stackNumber: 7, action: "remove" },
    },
    {
      name: "rebuilds when removal and insertion happen together",
      previous: stack("a", "b", "c"),
      changes: changes("a", "x", "c"),
      expected: { kind: "rebuild", stackNumber: 7, action: "update" },
    },
  ] as const)("$name", ({ previous, changes, states = {}, expected }) => {
    const transition = Stack.fromChanges(changes).transitionFrom(previous, {
      preserveHigherChanges: false,
      lookups: lookups(states),
    });

    expect(transition).toEqual(expected);
  });

  test("preserves higher changes when syncing a detached down-stack prefix", () => {
    const transition = Stack.fromChanges(changes("b")).transitionFrom(
      stack("a", "b", "c"),
      {
        preserveHigherChanges: true,
        lookups: lookups({ 1: "MERGED" }),
      },
    );

    expect(transition).toEqual({ kind: "partial", previousOffset: 1 });
  });

  test("uses a discovered stack number when local state lacks one", () => {
    const transition = Stack.fromChanges(changes("x", "a", "b")).transitionFrom(
      stackWithoutNumber("a", "b"),
      {
        preserveHigherChanges: false,
        lookups: lookups({}, 11),
      },
    );

    expect(transition).toEqual({
      kind: "rebuild",
      stackNumber: 11,
      action: "insert",
    });
  });

  test("rejects appending after a merge when local state lacks a stack number", () => {
    expect(() =>
      Stack.fromChanges(changes("b", "c")).transitionFrom(
        stackWithoutNumber("a", "b"),
        {
          preserveHigherChanges: false,
          lookups: lookups({ 1: "MERGED" }, 11),
        },
      ),
    ).toThrow("Cannot append after a merge");
  });
});

function changes(...ids: string[]): StackChange[] {
  return ids.map((id) => ({
    id,
    oid: `oid-${id}`,
    subject: `Change ${id}`,
    body: "",
    remoteBranch: `bstack/${id}`,
  }));
}

function stack(...ids: string[]): StoredStack {
  return {
    ...stackWithoutNumber(...ids),
    stackNumber: 7,
  };
}

function stackWithoutNumber(...ids: string[]): StoredStack {
  return {
    remote: "origin",
    base: "main",
    changes: ids.map((id, index) => ({
      id,
      remoteBranch: `bstack/${id}`,
      pullRequest: index + 1,
      url: `https://example.test/pull/${index + 1}`,
    })),
  };
}

function lookups(
  states: Record<number, PullRequest["state"]> = {},
  stackNumber: number | undefined = 7,
): StackTransitionLookups {
  return {
    pullRequestState(pullRequest) {
      return states[pullRequest] ?? "OPEN";
    },
    stackNumberForPullRequest() {
      return stackNumber;
    },
  };
}
