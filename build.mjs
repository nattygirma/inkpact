// Builds the Worker (dist/worker.js) and the browser app (public/assets).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("altstack.json", "utf8"));
const define = { __APP_VERSION__: JSON.stringify(version) };

rmSync("public/assets", { recursive: true, force: true });
mkdirSync("public/assets/fonts", { recursive: true });

await build({
  entryPoints: ["src/index.ts"], outfile: "dist/worker.js", bundle: true, format: "esm",
  platform: "browser", conditions: ["workerd", "worker", "browser"], target: "es2022", minify: true, define,
  external: ["cloudflare:*"],
});

await build({
  entryPoints: { app: "client/app.ts", sign: "client/sign.ts", "app-style": "client/app.css" },
  outdir: "public/assets", bundle: true, format: "esm", splitting: true, target: "es2022", minify: true,
  define, entryNames: "[name]", chunkNames: "chunks/[name]-[hash]", loader: { ".woff2": "file" }, assetNames: "fonts/[name]",
});
// esbuild names the CSS bundle after its entry; keep the public name stable.
cpSync("public/assets/app-style.css", "public/assets/app.css");
rmSync("public/assets/app-style.css");
rmSync("public/assets/app-style.js", { force: true });

cpSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "public/assets/pdf.worker.min.mjs");
cpSync("client/icon.svg", "public/assets/icon.svg");
console.log(`built Inkpact ${version}`);
