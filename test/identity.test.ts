import { describe, expect, test } from "bun:test";
import {
  addChangeId,
  parseRawCommit,
  readChangeId,
  rewriteCommit,
  splitCommitMessage,
} from "../src/identity";

describe("commit identity", () => {
  test("adds and reads a stable trailer without exposing it as PR body content", () => {
    const message = addChangeId(
      "Add the API\n\nExplain the endpoint.\n",
      "change123",
    );

    expect(readChangeId(message)).toBe("change123");
    expect(splitCommitMessage(message)).toEqual({
      subject: "Add the API",
      body: "Explain the endpoint.",
    });
  });

  test("rewrites only the parent and message of a raw commit", () => {
    const raw = [
      "tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "parent bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "author Ada <ada@example.com> 1 +0000",
      "committer Ada <ada@example.com> 1 +0000",
      "",
      "Original message",
      "",
    ].join("\n");
    const commit = parseRawCommit(
      "cccccccccccccccccccccccccccccccccccccccc",
      raw,
    );
    const rewritten = rewriteCommit(
      commit,
      "dddddddddddddddddddddddddddddddddddddddd",
      addChangeId(commit.message, "stable"),
    );

    expect(rewritten).toContain(
      "parent dddddddddddddddddddddddddddddddddddddddd",
    );
    expect(rewritten).toContain("author Ada <ada@example.com> 1 +0000");
    expect(rewritten).toEndWith("Bstack-Id: stable\n");
  });
});
