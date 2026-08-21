import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BstackState, StoredStack } from "./model";

const emptyState = (): BstackState => ({ schemaVersion: 1, stacks: [] });

export class StateStore {
  constructor(private readonly path: string) {}

  read(): BstackState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!isState(parsed)) {
        throw new Error(`Unsupported bstack state in ${this.path}`);
      }
      return parsed;
    } catch (error) {
      if (isMissingFile(error)) {
        return emptyState();
      }
      throw error;
    }
  }

  write(state: BstackState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.path);
  }

  findByChangeIds(
    state: BstackState,
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isState(value: unknown): value is BstackState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { schemaVersion?: unknown; stacks?: unknown };
  return candidate.schemaVersion === 1 && Array.isArray(candidate.stacks);
}
