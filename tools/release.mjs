// Builds the release downloads into release/ (macOS, with the Developer ID certificate and notarytool profile).
//
//   node tools/release.mjs [--notarize <profile>]     (default profile: kerf-notary)
//
//   release/Kerf-for-Silhouette.zip   the menu-bar app, universal, signed and notarized
//   release/kerf-helper.tgz           the `kerf` command: npm install -g <url of this file>
//   release/Kerf-Figma-plugin.zip     the Figma plugin (manifest.json + dist/), for "Import plugin from manifest…"
//
// File names carry no version, so https://github.com/keoshi/kerf/releases/latest/download/<name> always works.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const args = process.argv.slice(2);
const profile = args.includes("--notarize") ? args[args.indexOf("--notarize") + 1] : "kerf-notary";
const version = JSON.parse(readFileSync(join(root, "packages/helper-app/package.json"), "utf8")).version;
const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

run("npm", ["test"]);
run("npm", ["run", "build"]);

// 1. The app.
run("node", ["packages/helper-app/build.mjs", "--universal", "--notarize", profile]);
renameSync(join(root, `packages/helper-app/build/Kerf-${version}.zip`), join(out, "Kerf-for-Silhouette.zip"));

// 2. The command-line helper.
const tgz = execFileSync("npm", ["pack", "-w", "@kerf/helper", "--pack-destination", out], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .pop();
renameSync(join(out, tgz), join(out, "kerf-helper.tgz"));

// 3. The Figma plugin.
const plugin = join(out, "Kerf Figma plugin");
mkdirSync(join(plugin, "dist"), { recursive: true });
cpSync(join(root, "packages/figma-plugin/manifest.json"), join(plugin, "manifest.json"));
for (const f of ["code.js", "ui.html"]) cpSync(join(root, "packages/figma-plugin/dist", f), join(plugin, "dist", f));
run("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", plugin, join(out, "Kerf-Figma-plugin.zip")]);
rmSync(plugin, { recursive: true });

run("ls", ["-lh", out]);
