import type { CommandRunner } from "./command";
import {
  addChangeId,
  generateChangeId,
  parseRawCommit,
  rewriteCommit,
  splitCommitMessage,
} from "./commit";
import type { Commit, StackChange } from "./model";

export class GitRepository {
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

  assertReady(): void {
    this.git(["rev-parse", "--show-toplevel"]);

    const status = this.git(["status", "--porcelain"]).stdout;

    if (status.trim()) {
      throw new Error(
        "The working tree must be clean before bstack rewrites commits or pushes branches",
      );
    }
  }

  currentBranch(): string {
    return this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    }).stdout.trim();
  }

  remotes(): string[] {
    return this.git(["remote"]).stdout.split("\n").filter(Boolean);
  }

  configuredPushRemote(): string | undefined {
    const result = this.git(["config", "--get", "remote.pushDefault"], {
      allowFailure: true,
    });

    return result.exitCode === 0
      ? result.stdout.trim() || undefined
      : undefined;
  }

  resolveRemote(requested?: string): string {
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

  fetchBase(remote: string, base: string): string {
    const destination = `refs/remotes/${remote}/${base}`;

    this.git([
      "fetch",
      "--no-tags",
      remote,
      `refs/heads/${base}:${destination}`,
    ]);

    return destination;
  }

  fetchRemoteBranch(remote: string, branch: string): string {
    const destination = `refs/remotes/${remote}/${branch}`;

    this.git([
      "fetch",
      "--no-tags",
      remote,
      `+refs/heads/${branch}:${destination}`,
    ]);

    return destination;
  }

  checkout(ref: string): void {
    this.git(["checkout", "--detach", ref]);
  }

  mergeBase(left: string, right: string): string {
    return this.git(["merge-base", left, right]).stdout.trim();
  }

  commitsSince(baseOid: string): Commit[] {
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

  ensureChangeIds(
    commits: readonly Commit[],
    dryRun: boolean,
    userLogin: string,
  ): StackChange[] {
    const assigned = commits.map(
      (commit) => commit.changeId ?? generateChangeId(),
    );
    const needsRewrite = commits.some(
      (commit) => commit.changeId === undefined,
    );
    let parent = commits[0]?.parent;
    const rewrittenOids: string[] = [];

    if (needsRewrite && !dryRun) {
      for (const [index, commit] of commits.entries()) {
        const changeId = assigned[index]!;
        const message = commit.changeId
          ? commit.message
          : addChangeId(commit.message, changeId);
        const raw = rewriteCommit(commit, parent!, message);
        const oid = this.git(["hash-object", "-t", "commit", "-w", "--stdin"], {
          stdin: raw,
        }).stdout.trim();
        rewrittenOids.push(oid);
        parent = oid;
      }

      const oldHead = commits.at(-1)!.oid;
      const newHead = rewrittenOids.at(-1)!;
      this.git(["update-ref", "HEAD", newHead, oldHead]);
    }

    return commits.map((commit, index) => {
      const id = assigned[index]!;
      const oid = needsRewrite && !dryRun ? rewrittenOids[index]! : commit.oid;
      const { subject, body } = splitCommitMessage(commit.message);
      return {
        id,
        oid,
        subject,
        body,
        remoteBranch: `bstack/${userLogin}/${id}`,
      };
    });
  }

  remoteBranchOids(
    remote: string,
    branches: readonly string[],
  ): Map<string, string> {
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

  pushChanges(remote: string, changes: readonly StackChange[]): void {
    const existing = this.remoteBranchOids(
      remote,
      changes.map((change) => change.remoteBranch),
    );

    const leases: string[] = [];
    const refspecs: string[] = [];
    for (const change of changes) {
      const expected = existing.get(change.remoteBranch) ?? "";
      leases.push(
        `--force-with-lease=refs/heads/${change.remoteBranch}:${expected}`,
      );
      refspecs.push(`${change.oid}:refs/heads/${change.remoteBranch}`);
    }
    this.git(["push", "--atomic", ...leases, remote, ...refspecs]);
  }

  statePath(): string {
    return this.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "bstack/state.json",
    ]).stdout.trim();
  }
}
