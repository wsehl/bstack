export type Commit = {
  oid: string;
  tree: string;
  parent: string;
  message: string;
  headers: readonly string[];
  changeId: string | undefined;
};

export type StackChange = {
  id: string;
  oid: string;
  subject: string;
  body: string;
  remoteBranch: string;
};

export type PullRequest = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  body: string;
  isDraft: boolean;
};

export type StoredChange = {
  id: string;
  remoteBranch: string;
  pullRequest: number;
  url: string;
};

export type StoredStack = {
  remote: string;
  base: string;
  stackNumber?: number;
  changes: StoredChange[];
};

export type RepositoryState = {
  schemaVersion: 1;
  stacks: StoredStack[];
};
