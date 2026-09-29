import { describe, expect, test } from "vitest";

import {
  addChangeId,
  parseRawCommit,
  readChangeId,
  rewriteCommit,
  splitCommitMessage,
} from "../src/commit";

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

  test("joins an existing trailer block so git still recognizes it", () => {
    const message = addChangeId(
      "Add the API\n\nExplain the endpoint.\n\nCo-authored-by: Ada <ada@example.com>\n",
      "change123",
    );

    expect(message).toBe(
      "Add the API\n\nExplain the endpoint.\n\nCo-authored-by: Ada <ada@example.com>\nbstack-id: change123\n",
    );
    expect(splitCommitMessage(message)).toEqual({
      subject: "Add the API",
      body: "Explain the endpoint.\n\nCo-authored-by: Ada <ada@example.com>",
    });
  });

  test("starts a trailer block after prose and after a lone subject", () => {
    expect(addChangeId("fix: handle errors\n", "one")).toBe(
      "fix: handle errors\n\nbstack-id: one\n",
    );
    expect(
      addChangeId("Subject\n\nNote: this is prose\nnot a trailer\n", "two"),
    ).toBe("Subject\n\nNote: this is prose\nnot a trailer\n\nbstack-id: two\n");
  });

  test("falls back to a placeholder subject for an empty message", () => {
    expect(splitCommitMessage(addChangeId("", "change123"))).toEqual({
      subject: "Untitled change",
      body: "",
    });
  });

  test.each([
    ["gpgsig -----BEGIN PGP SIGNATURE-----", "is signed"],
    ["gpgsig-sha256 -----BEGIN PGP SIGNATURE-----", "is signed"],
    ["encoding ISO-8859-1", "uses the ISO-8859-1 message encoding"],
  ])("rejects commits with the %s header", (header, message) => {
    const raw = [
      "tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "parent bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "author Ada <ada@example.com> 1 +0000",
      "committer Ada <ada@example.com> 1 +0000",
      header,
      "",
      "Original message",
      "",
    ].join("\n");

    expect(() =>
      parseRawCommit("cccccccccccccccccccccccccccccccccccccccc", raw),
    ).toThrow(message);
  });

  test("accepts an explicit UTF-8 encoding header", () => {
    const raw = [
      "tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "parent bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "encoding UTF-8",
      "",
      "Original message",
      "",
    ].join("\n");

    expect(
      parseRawCommit("cccccccccccccccccccccccccccccccccccccccc", raw).message,
    ).toBe("Original message\n");
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
    expect(rewritten.endsWith("bstack-id: stable\n")).toBe(true);
  });
});
