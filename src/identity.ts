import { randomUUID } from "node:crypto";
import type { Commit } from "./model";

const trailerPattern = /^Bstack-Id:\s*(\S+)\s*$/gim;

type CommitMessage = {
  subject: string;
  body: string;
};

export function readChangeId(message: string): string | undefined {
  const matches = [...message.matchAll(trailerPattern)];
  if (matches.length > 1) {
    throw new Error("A commit contains more than one Bstack-Id trailer");
  }
  return matches[0]?.[1];
}

export function addChangeId(message: string, changeId: string): string {
  const trimmed = message.trimEnd();
  return `${trimmed}\n\nBstack-Id: ${changeId}\n`;
}

export function newChangeId(): string {
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
  if (headers.some((line) => line.startsWith("gpgsig "))) {
    throw new Error(
      `Commit ${oid} is signed. bstack cannot add an identity trailer without replacing its signature`,
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
    .filter((line) => !/^Bstack-Id:\s*\S+\s*$/i.test(line))
    .join("\n")
    .trim();
  const [subject = "Untitled change", ...bodyLines] =
    withoutIdentity.split("\n");
  return { subject, body: bodyLines.join("\n").trim() };
}
