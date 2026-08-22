import * as v from "valibot";
import type { CommandRunner } from "./command";
import type { PullRequest, StackChange } from "./model";

const pullRequestSchema = v.object({
  number: v.number(),
  url: v.string(),
  state: v.picklist(["OPEN", "CLOSED", "MERGED"]),
  title: v.string(),
  body: v.string(),
  isDraft: v.boolean(),
});

const stackSchema = v.object({ number: v.number() });

export interface GitHubPlatform {
  assertReady(): void;
  currentUserLogin(): string;
  defaultBranch(): string;
  pullRequestForBranch(branch: string): PullRequest | undefined;
  pullRequest(number: number): PullRequest;
  createPullRequest(
    change: StackChange,
    base: string,
    draft: boolean,
  ): PullRequest;
  linkStack(
    branches: readonly string[],
    base: string,
    remote: string,
    draft: boolean,
  ): void;
  appendToStack(
    stackNumber: number,
    branches: readonly string[],
    remote: string,
    draft: boolean,
  ): void;
  unstack(stackNumber: number): void;
  editPullRequestBase(pr: PullRequest, base: string): void;
  editPullRequest(pr: PullRequest, change: StackChange): void;
  stackNumberForPullRequest(prNumber: number): number | undefined;
  pullRequestHead(reference: string): string;
  checkoutPullRequest(reference: string): void;
}

export class GitHubCliPlatform implements GitHubPlatform {
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

  currentUserLogin(): string {
    const login = this.gh(["api", "user", "--jq", ".login"]).stdout.trim();

    return v.parse(v.pipe(v.string(), v.minLength(1)), login);
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
    const candidates = v.parse(v.array(pullRequestSchema), JSON.parse(raw));

    const selected =
      candidates.find((pr) => pr.state === "OPEN") ??
      candidates.find((pr) => pr.state === "MERGED");

    return selected;
  }

  pullRequest(number: number): PullRequest {
    const raw = this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "number,url,state,title,body,isDraft",
    ]).stdout;

    return v.parse(pullRequestSchema, JSON.parse(raw));
  }

  createPullRequest(
    change: StackChange,
    base: string,
    draft: boolean,
  ): PullRequest {
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
    if (draft) {
      args.push("--draft");
    }
    this.gh(args);

    const created = this.pullRequestForBranch(change.remoteBranch);
    if (!created) {
      throw new Error(
        `GitHub did not return the PR created for ${change.remoteBranch}`,
      );
    }

    return created;
  }

  linkStack(
    branches: readonly string[],
    base: string,
    remote: string,
    draft: boolean,
  ): void {
    const args = ["stack", "link", "--base", base, "--remote", remote];

    if (!draft) {
      args.push("--open");
    }
    args.push(...branches);

    this.gh(args);
  }

  appendToStack(
    stackNumber: number,
    branches: readonly string[],
    remote: string,
    draft: boolean,
  ): void {
    const args = ["stack", "link", "--remote", remote];

    if (!draft) {
      args.push("--open");
    }
    args.push(String(stackNumber), ...branches);

    this.gh(args);
  }

  unstack(stackNumber: number): void {
    this.gh(["stack", "unstack", String(stackNumber)]);
  }

  editPullRequestBase(pr: PullRequest, base: string): void {
    this.gh(["pr", "edit", String(pr.number), "--base", base]);
  }

  editPullRequest(pr: PullRequest, change: StackChange): void {
    if (pr.title === change.subject && pr.body === change.body) {
      return;
    }

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

    const stacks = v.parse(v.array(stackSchema), JSON.parse(raw));

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
