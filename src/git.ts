import type { CommandRunner } from "./command";
import { parseRawCommit, rewriteCommit } from "./commit";
import type { Commit } from "./model";

export type CommitRewrite = {
  commit: Commit;
  message: string;
};

export type BranchUpdate = {
  name: string;
  oid: string;
};

export interface GitRepository {
  assertReady(): void;
  currentBranch(): string;
  resolveRemote(requested?: string): string;
  fetchBase(remote: string, base: string): string;
  fetchRemoteBranch(remote: string, branch: string): string;
  checkout(ref: string): void;
  mergeBase(left: string, right: string): string;
  commitsSince(baseOid: string): Commit[];
  rewriteCommits(rewrites: readonly CommitRewrite[]): string[];
  pushBranches(remote: string, branches: readonly BranchUpdate[]): void;
  statePath(): string;
}

export class GitCliRepository implements GitRepository {
  constructor(
    readonly cwd: string,
    private readonly runner: CommandRunner,
  ) {}

  private git(
    args: readonly string[],
    options: { stdin?: string; allowFailure?: boolean } = {},
  ) {
    return this.runner.run(["git", ...args], { cwd: this.cwd, ...options });
  }

  assertReady() {
    this.git(["rev-parse", "--show-toplevel"]);

    const status = this.git(["status", "--porcelain"]).stdout;

    if (status.trim()) {
      throw new Error(
        "The working tree must be clean before bstack rewrites commits or pushes branches",
      );
    }
  }

  currentBranch() {
    return this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    }).stdout.trim();
  }

  resolveRemote(requested?: string) {
    if (requested) {
      if (!this.remotes().includes(requested)) {
        throw new Error(`Git remote ${requested} does not exist`);
      }

      return requested;
    }

    const configured = this.configuredPushRemote();
    if (configured) {
      return configured;
    }

    const remotes = this.remotes();
    if (remotes.length === 1) {
      return remotes[0]!;
    }

    if (remotes.includes("origin")) {
      return "origin";
    }

    throw new Error(
      "Cannot choose a Git remote. Pass --remote or configure remote.pushDefault",
    );
  }

  fetchBase(remote: string, base: string) {
    const destination = `refs/remotes/${remote}/${base}`;

    this.git([
      "fetch",
      "--no-tags",
      remote,
      `refs/heads/${base}:${destination}`,
    ]);

    return destination;
  }

  fetchRemoteBranch(remote: string, branch: string) {
    const destination = `refs/remotes/${remote}/${branch}`;

    this.git([
      "fetch",
      "--no-tags",
      remote,
      `+refs/heads/${branch}:${destination}`,
    ]);

    return destination;
  }

  checkout(ref: string) {
    this.git(["checkout", "--detach", ref]);
  }

  mergeBase(left: string, right: string) {
    return this.git(["merge-base", left, right]).stdout.trim();
  }

  commitsSince(baseOid: string) {
    const oids = this.git([
      "rev-list",
      "--reverse",
      "--first-parent",
      `${baseOid}..HEAD`,
    ])
      .stdout.split("\n")
      .filter(Boolean);

    return oids.map((oid) =>
      parseRawCommit(oid, this.git(["cat-file", "commit", oid]).stdout),
    );
  }

  rewriteCommits(rewrites: readonly CommitRewrite[]) {
    if (rewrites.length === 0) {
      return [];
    }

    let parent = rewrites[0]!.commit.parent;
    const rewrittenOids: string[] = [];

    for (const rewrite of rewrites) {
      const raw = rewriteCommit(rewrite.commit, parent, rewrite.message);
      const oid = this.git(["hash-object", "-t", "commit", "-w", "--stdin"], {
        stdin: raw,
      }).stdout.trim();
      rewrittenOids.push(oid);
      parent = oid;
    }

    const oldHead = rewrites.at(-1)!.commit.oid;
    const newHead = rewrittenOids.at(-1)!;
    this.git(["update-ref", "HEAD", newHead, oldHead]);

    return rewrittenOids;
  }

  pushBranches(remote: string, branches: readonly BranchUpdate[]) {
    const existing = this.remoteBranchOids(
      remote,
      branches.map((branch) => branch.name),
    );
    const leases: string[] = [];
    const refspecs: string[] = [];

    for (const branch of branches) {
      const expected = existing.get(branch.name) ?? "";
      leases.push(`--force-with-lease=refs/heads/${branch.name}:${expected}`);
      refspecs.push(`${branch.oid}:refs/heads/${branch.name}`);
    }
    this.git(["push", "--atomic", ...leases, remote, ...refspecs]);
  }

  statePath() {
    return this.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "bstack/state.json",
    ]).stdout.trim();
  }

  private remotes() {
    return this.git(["remote"]).stdout.split("\n").filter(Boolean);
  }

  private configuredPushRemote() {
    const result = this.git(["config", "--get", "remote.pushDefault"], {
      allowFailure: true,
    });

    return result.exitCode === 0
      ? result.stdout.trim() || undefined
      : undefined;
  }

  private remoteBranchOids(remote: string, branches: readonly string[]) {
    if (branches.length === 0) {
      return new Map();
    }

    const result = this.git([
      "ls-remote",
      "--heads",
      remote,
      ...branches.map((branch) => `refs/heads/${branch}`),
    ]);

    return new Map(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [oid, ref] = line.split(/\s+/, 2);

          return [ref!.replace("refs/heads/", ""), oid!] as const;
        }),
    );
  }
}
