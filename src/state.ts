import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { RepositoryState, StoredStack } from "./model";

const emptyState = (): RepositoryState => ({ schemaVersion: 1, stacks: [] });

const storedChangeSchema = z.object({
  id: z.string(),
  remoteBranch: z.string(),
  pullRequest: z.number(),
  url: z.string(),
});

const storedStackSchema = z.object({
  remote: z.string(),
  base: z.string(),
  stackNumber: z.number().optional(),
  changes: storedChangeSchema.array(),
});

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  stacks: storedStackSchema.array(),
});

export class StateStore {
  constructor(private readonly path: string) {}

  read(): RepositoryState {
    try {
      const parsed = stateSchema.parse(
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

      return { schemaVersion: 1, stacks };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return emptyState();
      }

      if (error instanceof z.ZodError) {
        throw new Error(`Unsupported bstack state in ${this.path}`, {
          cause: error,
        });
      }

      throw error;
    }
  }

  write(state: RepositoryState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.path);
  }

  findByChangeIds(
    state: RepositoryState,
    ids: ReadonlySet<string>,
  ): StoredStack | undefined {
    const matches = state.stacks.filter((stack) =>
      stack.changes.some((change) => ids.has(change.id)),
    );

    if (matches.length > 1) {
      throw new Error(
        "The current commits match more than one stored bstack stack",
      );
    }

    return matches[0];
  }
}
