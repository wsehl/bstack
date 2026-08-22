import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    bstack: "src/cli.ts",
  },
  format: "esm",
  platform: "node",
});
