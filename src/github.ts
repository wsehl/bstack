import type { CommandRunner } from "./command";
import type { Change, PullRequest } from "./model";

type PullRequestJson = {
  number: number;
  url: string;
  state: string;
  title: string;
  body: string;
  isDraft: boolean;
};

type StackJson = { number: number };

export interface GitHubPlatform {
  assertReady(): void;
  defaultBranch(): string;
  pullRequestForBranch(branch: string): PullRequest | undefined;
  pullRequest(number: number): PullRequest;
  createPullRequest(change: Change, base: string, open: boolean): PullRequest;
  linkStack(
    branches: readonly string[],
    base: string,
    remote: string,
    open: boolean,
  ): void;
  appendToStack(
    stackNumber: number,
    branches: readonly string[],
    remote: string,
    open: boolean,
  ): void;
  editPullRequest(pr: PullRequest, change: Change): void;
  stackNumberForPullRequest(prNumber: number): number | undefined;
  pullRequestHead(reference: string): string;
  checkoutPullRequest(reference: string): void;
}

export class GhPlatform implements GitHubPlatform {
  constructor(
    private readonly cwd: string,
    private readonly runner: CommandRunner,
  ) {}

  private gh(args: readonly string[]) {
    return this.runner.run(["gh", ...args], { cwd: this.cwd });
  }

  assertReady(): void {
    this.gh(["auth", "status", "--active"]);
    this.gh(["stack", "--version"]);
  }

  defaultBranch(): string {
    return this.gh([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]).stdout.trim();
  }

  pullRequestForBranch(branch: string): PullRequest | undefined {
    const raw = this.gh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "20",
      "--json",
      "number,url,state,title,body,isDraft",
    ]).stdout;
    const candidates = JSON.parse(raw) as PullRequestJson[];
    const selected =
      candidates.find((pr) => pr.state === "OPEN") ??
      candidates.find((pr) => pr.state === "MERGED");
    return selected ? normalizePullRequest(selected) : undefined;
  }

  pullRequest(number: number): PullRequest {
    const raw = this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "number,url,state,title,body,isDraft",
    ]).stdout;
    return normalizePullRequest(JSON.parse(raw) as PullRequestJson);
  }

  createPullRequest(change: Change, base: string, open: boolean): PullRequest {
    const args = [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      change.remoteBranch,
      "--title",
      change.subject,
      "--body",
      change.body,
    ];
    if (!open) args.push("--draft");
    this.gh(args);
    const created = this.pullRequestForBranch(change.remoteBranch);
    if (!created)
      throw new Error(
        `GitHub did not return the PR created for ${change.remoteBranch}`,
      );
    return created;
  }

  linkStack(
    branches: readonly string[],
    base: string,
    remote: string,
    open: boolean,
  ): void {
    const args = ["stack", "link", "--base", base, "--remote", remote];
    if (open) args.push("--open");
    args.push(...branches);
    this.gh(args);
  }

  appendToStack(
    stackNumber: number,
    branches: readonly string[],
    remote: string,
    open: boolean,
  ): void {
    const args = ["stack", "link", "--remote", remote];
    if (open) args.push("--open");
    args.push(String(stackNumber), ...branches);
    this.gh(args);
  }

  editPullRequest(pr: PullRequest, change: Change): void {
    if (pr.title === change.subject && pr.body === change.body) return;
    this.gh([
      "pr",
      "edit",
      String(pr.number),
      "--title",
      change.subject,
      "--body",
      change.body,
    ]);
  }

  stackNumberForPullRequest(prNumber: number): number | undefined {
    const raw = this.gh([
      "api",
      `repos/{owner}/{repo}/stacks?pull_request=${prNumber}`,
    ]).stdout;
    const stacks = JSON.parse(raw) as StackJson[];
    return stacks[0]?.number;
  }

  pullRequestHead(reference: string): string {
    return this.gh([
      "pr",
      "view",
      reference,
      "--json",
      "headRefName",
      "--jq",
      ".headRefName",
    ]).stdout.trim();
  }

  checkoutPullRequest(reference: string): void {
    this.gh(["pr", "checkout", reference]);
  }
}

function normalizePullRequest(pr: PullRequestJson): PullRequest {
  if (pr.state !== "OPEN" && pr.state !== "CLOSED" && pr.state !== "MERGED") {
    throw new Error(`GitHub returned an unknown PR state: ${pr.state}`);
  }
  return { ...pr, state: pr.state };
}
