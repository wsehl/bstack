import { describe, expect, test } from "vitest";

import { formatHelp, parseCli } from "../src/cli-options";

describe("CLI parsing", () => {
  test.each([[], ["sync"]])("defaults sync options for %j", (...argv) => {
    expect(parseCli(argv)).toEqual({
      command: "sync",
      verbose: false,
      options: {
        base: undefined,
        remote: undefined,
        draft: false,
        dryRun: false,
      },
    });
  });

  test.each([
    [
      "--base",
      "main",
      "sync",
      "--remote=upstream",
      "--draft",
      "--dry-run",
      "--verbose",
    ],
    [
      "--base",
      "main",
      "--remote=upstream",
      "--draft",
      "--dry-run",
      "--verbose",
    ],
  ])("parses sync flags for %j", (...argv) => {
    expect(parseCli(argv)).toEqual({
      command: "sync",
      verbose: true,
      options: { base: "main", remote: "upstream", draft: true, dryRun: true },
    });
  });

  test.each(["42", "https://github.com/owner/repo/pull/42"])(
    "parses checkout reference %s",
    (reference) => {
      expect(parseCli(["checkout", reference])).toEqual({
        command: "checkout",
        verbose: false,
        options: {
          reference,
          base: undefined,
          remote: undefined,
          sameBase: false,
        },
      });
    },
  );

  test("accepts checkout flags before and after positionals", () => {
    expect(
      parseCli([
        "--verbose",
        "--base=main",
        "checkout",
        "--remote",
        "upstream",
        "42",
        "--same-base",
      ]),
    ).toEqual({
      command: "checkout",
      verbose: true,
      options: {
        reference: "42",
        base: "main",
        remote: "upstream",
        sameBase: true,
      },
    });
  });

  test("honors the end-of-options separator", () => {
    expect(parseCli(["checkout", "--", "--help"])).toMatchObject({
      command: "checkout",
      options: { reference: "--help" },
    });
  });

  test.each([
    {
      argv: ["checkout", "42", "--dry-run"],
      message: "Option --dry-run is not supported by checkout",
    },
    {
      argv: ["--draft", "checkout", "42"],
      message: "Option --draft is not supported by checkout",
    },
    {
      argv: ["sync", "--same-base"],
      message: "Option --same-base is not supported by sync",
    },
    {
      argv: ["--same-base"],
      message: "Option --same-base is not supported by sync",
    },
    { argv: ["checkout"], message: "Usage: bstack checkout" },
    { argv: ["checkout", "42", "extra"], message: "Usage: bstack checkout" },
    { argv: ["sync", "extra"], message: "Usage: bstack [sync]" },
    { argv: ["unknown"], message: "Unknown command: unknown" },
    { argv: ["--unknown"], message: "Unknown option" },
    { argv: ["--base"], message: "argument missing" },
    { argv: ["checkout", "42", "--remote"], message: "argument missing" },
  ])("rejects $argv", ({ argv, message }) => {
    expect(() => parseCli(argv)).toThrow(message);
  });

  test.each([
    { argv: ["--help"], topic: undefined },
    { argv: ["-h"], topic: undefined },
    { argv: ["sync", "--help"], topic: "sync" },
    { argv: ["checkout", "-h"], topic: "checkout" },
    { argv: ["--help", "checkout"], topic: "checkout" },
  ])(
    "returns help without requiring command arguments for $argv",
    ({ argv, topic }) => {
      expect(parseCli(argv)).toEqual({ command: "help", topic });
    },
  );

  test.each(["--version", "-v"])("returns version for %s", (flag) => {
    expect(parseCli([flag])).toEqual({ command: "version" });
  });

  test("prefers help when both help and version are requested", () => {
    expect(parseCli(["--help", "--version"])).toEqual({
      command: "help",
      topic: undefined,
    });
  });
});

describe("CLI help", () => {
  test.each([undefined, "sync", "checkout"] as const)(
    "omits the trailing newline for %s",
    (topic) => {
      expect(formatHelp(topic).endsWith("\n")).toBe(false);
    },
  );

  test("lists both commands and their flags in root help", () => {
    const help = formatHelp();
    expect(help).toContain("bstack [sync] [options]");
    expect(help).toContain("bstack checkout <PR-number-or-URL> [options]");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--same-base");
  });

  test.each(["sync", "checkout"] as const)(
    "includes shared options for %s",
    (topic) => {
      const help = formatHelp(topic);
      for (const flag of [
        "--base <branch>",
        "--remote <name>",
        "--verbose",
        "-v, --version",
        "-h, --help",
      ]) {
        expect(help).toContain(flag);
      }
    },
  );

  test("only includes sync options in sync help", () => {
    const help = formatHelp("sync");
    expect(help).toContain("--draft");
    expect(help).toContain("--dry-run");
    expect(help).not.toContain("--same-base");
    expect(help).not.toContain("bstack checkout");
  });

  test("only includes checkout options in checkout help", () => {
    const help = formatHelp("checkout");
    expect(help).toContain("--same-base");
    expect(help).not.toContain("--draft");
    expect(help).not.toContain("--dry-run");
    expect(help).not.toContain("bstack [sync]");
  });
});
