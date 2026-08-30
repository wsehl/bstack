import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as v from "valibot";

import type { RepositoryState, StoredStack } from "./model";

const emptyState = (): RepositoryState => ({ schemaVersion: 1, stacks: [] });

const storedChangeSchema = v.object({
  id: v.string(),
  remoteBranch: v.string(),
  pullRequest: v.number(),
  url: v.string(),
});

const storedStackSchema = v.object({
  remote: v.string(),
  base: v.string(),
  stackNumber: v.optional(v.number()),
  changes: v.array(storedChangeSchema),
});

const stateSchema = v.object({
  schemaVersion: v.literal(1),
  stacks: v.array(storedStackSchema),
});

export interface StateStore {
  read(): RepositoryState;
  write(state: RepositoryState): void;
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  read() {
    try {
      const parsed = v.parse(
        stateSchema,
        JSON.parse(readFileSync(this.path, "utf8")),
      );

      const stacks = parsed.stacks.map((stack): StoredStack => {
        const stored: StoredStack = {
          remote: stack.remote,
          base: stack.base,
          changes: stack.changes,
        };
        if (stack.stackNumber !== undefined) {
          stored.stackNumber = stack.stackNumber;
        }
        return stored;
      });

      return { schemaVersion: 1, stacks } satisfies RepositoryState;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return emptyState();
      }

      if (v.isValiError(error)) {
        throw new Error(`Unsupported bstack state in ${this.path}`, {
          cause: error,
        });
      }

      throw error;
    }
  }

  write(state: RepositoryState) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.path);
  }
}
