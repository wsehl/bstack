import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test as baseTest } from "vitest";

type TempDirFixture = {
  temporaryDirectory: string;
};

export const test = baseTest.extend<TempDirFixture>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest requires fixture dependencies to use object destructuring.
  temporaryDirectory: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), "bstack-test-"));

    await use(directory);

    rmSync(directory, { recursive: true, force: true });
  },
});
