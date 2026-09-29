import { randomUUID } from "node:crypto";

import type { Commit } from "./model";

const CHANGE_ID_TRAILER = "bstack-id";

const changeIdTrailerPattern = new RegExp(
  `^${CHANGE_ID_TRAILER}:\\s*(\\S+)\\s*$`,
  "gm",
);

const changeIdTrailerLinePattern = new RegExp(
  `^${CHANGE_ID_TRAILER}:\\s*\\S+\\s*$`,
);

// Git trailer lines look like `Token: value`; indented lines continue the
// previous trailer.
const trailerLinePattern = /^[A-Za-z0-9-]+:\s/;
const trailerContinuationPattern = /^[ \t]/;

type CommitMessage = {
  subject: string;
  body: string;
};

export function readChangeId(message: string): string | undefined {
  const matches = [...message.matchAll(changeIdTrailerPattern)];

  if (matches.length > 1) {
    throw new Error(
      `A commit contains more than one ${CHANGE_ID_TRAILER} trailer`,
    );
  }

  return matches[0]?.[1];
}

export function addChangeId(message: string, changeId: string): string {
  const trimmed = message.trimEnd();
  const separator = endsWithTrailerBlock(trimmed) ? "\n" : "\n\n";

  return `${trimmed}${separator}${CHANGE_ID_TRAILER}: ${changeId}\n`;
}

// Git only reads trailers from the final paragraph, so the change ID must
// join an existing trailer block instead of starting a new paragraph after
// it, which would hide trailers such as Co-authored-by.
function endsWithTrailerBlock(message: string): boolean {
  const paragraphs = message.split(/\n[ \t]*\n/);

  if (paragraphs.length < 2) {
    return false;
  }

  const lines = paragraphs.at(-1)!.split("\n");

  return (
    trailerLinePattern.test(lines[0]!) &&
    lines.every(
      (line) =>
        trailerLinePattern.test(line) || trailerContinuationPattern.test(line),
    )
  );
}

export function generateChangeId(): string {
  return randomUUID().replaceAll("-", "");
}

export function parseRawCommit(oid: string, raw: string): Commit {
  const boundary = raw.indexOf("\n\n");

  if (boundary === -1) {
    throw new Error(`Commit ${oid} has an invalid object format`);
  }

  const headers = raw.slice(0, boundary).split("\n");
  const treeLine = headers.find((line) => line.startsWith("tree "));
  const parents = headers.filter((line) => line.startsWith("parent "));

  if (!treeLine || parents.length !== 1) {
    throw new Error(
      `Commit ${oid} must have exactly one parent; merge and root commits are not supported`,
    );
  }

  if (
    headers.some(
      (line) => line.startsWith("gpgsig ") || line.startsWith("gpgsig-sha256 "),
    )
  ) {
    throw new Error(
      `Commit ${oid} is signed. bstack cannot add an identity trailer without replacing its signature`,
    );
  }

  const encoding = headers
    .find((line) => line.startsWith("encoding "))
    ?.slice("encoding ".length);

  if (encoding && !/^utf-?8$/i.test(encoding)) {
    throw new Error(
      `Commit ${oid} uses the ${encoding} message encoding; bstack only supports UTF-8 commit messages`,
    );
  }

  const message = raw.slice(boundary + 2);

  return {
    oid,
    tree: treeLine.slice("tree ".length),
    parent: parents[0]!.slice("parent ".length),
    message,
    headers,
    changeId: readChangeId(message),
  };
}

export function rewriteCommit(
  commit: Commit,
  parent: string,
  message: string,
): string {
  const rewrittenHeaders: string[] = [];
  let replacedParent = false;

  for (const header of commit.headers) {
    if (header.startsWith("parent ")) {
      if (!replacedParent) {
        rewrittenHeaders.push(`parent ${parent}`);
        replacedParent = true;
      }

      continue;
    }

    rewrittenHeaders.push(header);
  }

  return `${rewrittenHeaders.join("\n")}\n\n${message}`;
}

export function splitCommitMessage(message: string): CommitMessage {
  const withoutIdentity = message
    .split("\n")
    .filter((line) => !changeIdTrailerLinePattern.test(line))
    .join("\n")
    .trim();

  const [subject = "", ...bodyLines] = withoutIdentity.split("\n");

  return {
    subject: subject.trim() || "Untitled change",
    body: bodyLines.join("\n").trim(),
  };
}
