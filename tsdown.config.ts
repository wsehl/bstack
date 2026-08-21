import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    bstack: "src/cli.ts",
  },
  clean: true,
  fixedExtension: false,
  format: "esm",
  platform: "node",
});
