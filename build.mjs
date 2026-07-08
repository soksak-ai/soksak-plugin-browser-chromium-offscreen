// soksak-plugin-browser-osr 번들 빌드 — esbuild 단일 ESM main.js(로더가 blob-URL 로 import).
import { build, context } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const opts = {
  entryPoints: ["src/plugin-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  alias: { "@": path.resolve(root, "src") },
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[browser-osr] watching src → main.js …");
} else {
  await build(opts);
  console.log("[browser-osr] built main.js");
}
