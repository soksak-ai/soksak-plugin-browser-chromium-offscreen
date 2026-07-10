// soksak-plugin-browser-chromium-offscreen 번들 빌드 — esbuild 단일 ESM main.js(로더가 blob-URL 로 import).
import { build, context } from "esbuild";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// ── kit 해석: 선언(package.json dependencies) + 발견(SOKSAK_HOME/kits/<이름>) ──
// 상대 위상·symlink 금지 — 소비자는 이름만 선언하고, 위치는 레지스트라(kits/)에서 발견한다.
// tsc 도 같은 발견을 쓴다: tsconfig.paths.json 을 여기서 생성(수기 topology 금지, extends 로 공급).
const SOKSAK_HOME = process.env.SOKSAK_HOME ?? path.join(os.homedir(), ".soksak-dev");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const kits = Object.fromEntries(
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .map((n) => [n, path.join(SOKSAK_HOME, "kits", n, "src", "index.ts")])
    .filter(([, p]) => fs.existsSync(p)),
);
fs.writeFileSync(
  path.join(root, "tsconfig.paths.json"),
  JSON.stringify(
    { compilerOptions: { paths: { "@/*": ["./src/*"], ...Object.fromEntries(Object.entries(kits).map(([n, p]) => [n, [p]])) } } },
    null,
    2,
  ) + "\n",
);

const opts = {
  entryPoints: ["src/plugin-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  alias: { "@": path.resolve(root, "src"), ...kits },
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[chromium-offscreen] watching src → main.js …");
} else {
  await build(opts);
  console.log("[chromium-offscreen] built main.js");
}
