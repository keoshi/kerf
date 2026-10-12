// Bundles the plugin's main thread (dist/code.js) and inlines the UI script into dist/ui.html,
// since Figma loads the UI as a single HTML string.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
await mkdir("dist", { recursive: true });

const common = { bundle: true, target: "es2017", logLevel: "info" };

const inlineUi = {
  name: "inline-ui",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const js = result.outputFiles[0].text.replace(/<\/script>/g, "<\\/script>");
      const html = await readFile("src/ui.html", "utf8");
      await writeFile("dist/ui.html", html.replace("<!-- SCRIPT -->", `<script>${js}</script>`));
    });
  },
};

const code = { ...common, entryPoints: ["src/code.ts"], outfile: "dist/code.js" };
const ui = { ...common, entryPoints: ["src/ui.ts"], write: false, outfile: "dist/ui.js", plugins: [inlineUi] };

if (watch) {
  for (const options of [code, ui]) await (await esbuild.context(options)).watch();
} else {
  await Promise.all([esbuild.build(code), esbuild.build(ui)]);
}
