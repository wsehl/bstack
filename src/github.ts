import * as v from "valibot";

import type { PullRequest, StackChange } from "./model";
import type { ProcessRunner } from "./process-runner";

const pullRequestSchema = v.object({
  number: v.number(),
  url: v.string(),
  state: v.picklist(["OPEN", "CLOSED", "MERGED"]),
  title: v.string(),
  body: v.string(),
  isDraft: v.boolean(),
});

const createdPullRequestSchema = v.object({
  number: v.number(),
  html_url: v.string(),
  state: v.picklist(["open", "closed"]),
  title: v.string(),
  body: v.nullable(v.string()),
  draft: v.boolean(),
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
    pullRequests: readonly number[],
    base: string,
    remote: string,
    draft: boolean,
  ): void;
  appendToStack(
    stackNumber: number,
    pullRequests: readonly number[],
    remote: string,
    draft: boolean,
  ): void;
  unstack(stackNumber: number): void;
  closePullRequest(pr: PullRequest): void;
  editPullRequestBase(pr: PullRequest, base: string): void;
  editPullRequest(pr: PullRequest, change: StackChange): void;
  stackNumberForPullRequest(prNumber: number): number | undefined;
  pullRequestHead(reference: string): string;
  checkoutPullRequest(reference: string): void;
}

export class GitHubCliPlatform implements GitHubPlatform {
  constructor(
    private readonly cwd: string,
    private readonly runner: ProcessRunner,
  ) {}

  private gh(args: readonly string[]) {
    return this.runner.run(["gh", ...args], { cwd: this.cwd });
  }

  assertReady() {
    this.gh(["auth", "status", "--active"]);
    this.gh(["stack", "--version"]);
  }

  currentUserLogin() {
    const login = this.gh(["api", "user", "--jq", ".login"]).stdout.trim();

    return v.parse(v.pipe(v.string(), v.minLength(1)), login);
  }

  defaultBranch() {
    return this.gh([
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]).stdout.trim();
  }

  pullRequestForBranch(branch: string) {
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

  pullRequest(number: number) {
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
    const raw = this.gh([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls",
      "--raw-field",
      `base=${base}`,
      "--raw-field",
      `head=${change.remoteBranch}`,
      "--raw-field",
      `title=${change.subject}`,
      "--raw-field",
      `body=${change.body}`,
      "--field",
      `draft=${draft}`,
    ]).stdout;
    const created = v.parse(createdPullRequestSchema, JSON.parse(raw));

    return {
      number: created.number,
      url: created.html_url,
      state: created.state === "open" ? "OPEN" : "CLOSED",
      title: created.title,
      body: created.body ?? "",
      isDraft: created.draft,
    };
  }

  linkStack(
    pullRequests: readonly number[],
    base: string,
    remote: string,
    draft: boolean,
  ) {
    const args = ["stack", "link", "--base", base, "--remote", remote];

    if (!draft) {
      args.push("--open");
    }
    args.push(...pullRequests.map(String));

    this.gh(args);
  }

  appendToStack(
    stackNumber: number,
    pullRequests: readonly number[],
    remote: string,
    draft: boolean,
  ) {
    const args = ["stack", "link", "--remote", remote];

    if (!draft) {
      args.push("--open");
    }
    args.push(String(stackNumber), ...pullRequests.map(String));

    this.gh(args);
  }

  unstack(stackNumber: number) {
    this.gh(["stack", "unstack", String(stackNumber)]);
  }

  closePullRequest(pr: PullRequest) {
    this.gh(["pr", "close", String(pr.number)]);
  }

  editPullRequestBase(pr: PullRequest, base: string) {
    this.gh(["pr", "edit", String(pr.number), "--base", base]);
  }

  editPullRequest(pr: PullRequest, change: StackChange) {
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

  stackNumberForPullRequest(prNumber: number) {
    const raw = this.gh([
      "api",
      `repos/{owner}/{repo}/stacks?pull_request=${prNumber}`,
    ]).stdout;

    const stacks = v.parse(v.array(stackSchema), JSON.parse(raw));

    return stacks[0]?.number;
  }

  pullRequestHead(reference: string) {
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

  checkoutPullRequest(reference: string) {
    this.gh(["pr", "checkout", reference]);
  }
}
