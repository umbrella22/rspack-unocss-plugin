import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/loader.ts"],
  format: "esm",
  dts: true,
  clean: true,
  platform: "node",
  target: "es2022",
});
