// Builds "Kerf for Silhouette.app": a self-contained menu-bar app with Node and the helper inside (macOS only).
//
//   npm run app                                   build, install to ~/Applications and open
//   node packages/helper-app/build.mjs [options]
//
// Options:
//   --install               copy to ~/Applications and open it
//   --universal             Apple Silicon + Intel (default: this Mac's architecture only)
//   --identity "<name>"     code-signing identity (default: first "Developer ID Application", else
//                           "Apple Development", else ad-hoc)
//   --notarize <profile>    notarize and staple with a notarytool keychain profile (needs Developer ID)
//
// Layout:
//   Contents/MacOS/Kerf                   Swift launcher (src/main.swift)
//   Contents/Resources/AppIcon.icns, MenuBarIcon*.png   drawn by src/make-icons.swift
//   Contents/Helpers/node                 official Node.js binary, checksum-verified
//   Contents/Resources/helper/main.js     the bundled helper (packages/helper/dist/main.js)
//   Contents/Resources/helper/node_modules/…   noble and its runtime dependencies
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** App name in Finder, Spotlight and Login Items: descriptive, so it's easy to find. */
const NAME = "Kerf for Silhouette";
const EXECUTABLE = "Kerf";
const BUNDLE_ID = "dev.kerf.Kerf";
const VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
const NODE_VERSION = process.version; // the bundled Node matches the one building it
const script = join(here, "../helper/dist/main.js");
const nodeModules = join(here, "../../node_modules");
/** Runtime dependencies of @stoprocent/noble on macOS (patch-package and node-addon-api are build-time only). */
const RUNTIME_MODULES = ["@stoprocent/noble", "debug", "ms", "node-gyp-build"];

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...opts });
const output = (cmd, argv) => execFileSync(cmd, argv, { encoding: "utf8" });

if (process.platform !== "darwin") throw new Error("The Kerf app is macOS only");
if (!existsSync(script)) throw new Error("Build the helper first: npm run build -w @kerf/helper");

const arches = args.includes("--universal") ? ["arm64", "x64"] : [process.arch];
const identity = option("--identity") ?? pickIdentity();
const developerId = identity.startsWith("Developer ID Application");
const notaryProfile = option("--notarize");
if (notaryProfile && !developerId) throw new Error("Notarization needs a \"Developer ID Application\" identity");

// ---------- Node.js ----------

/** Download the official Node.js build for an architecture, verify it against SHASUMS256.txt, return bin/node. */
async function officialNode(arch) {
  const cache = join(here, ".cache", `node-${NODE_VERSION}-darwin-${arch}`);
  const bin = join(cache, "node");
  if (existsSync(bin)) return bin;
  mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const file = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  console.log(`Downloading ${base}/${file}`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
  if (!expected) throw new Error(`No checksum for ${file}`);
  const tarball = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer());
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}`);
  const tgz = join(cache, file);
  writeFileSync(tgz, tarball);
  run("tar", ["-xzf", tgz, "-C", cache, "--strip-components", "2", `node-${NODE_VERSION}-darwin-${arch}/bin/node`]);
  rmSync(tgz);
  return bin;
}

function pickIdentity() {
  const ids = output("security", ["find-identity", "-v", "-p", "codesigning"]);
  const names = [...ids.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return names.find((n) => n.startsWith("Developer ID Application")) ?? names.find((n) => n.startsWith("Apple Development")) ?? "-";
}

// ---------- bundle ----------

const app = join(here, "build", `${NAME}.app`);
rmSync(app, { recursive: true, force: true });
for (const dir of ["MacOS", "Helpers", "Resources"]) mkdirSync(join(app, "Contents", dir), { recursive: true });

writeFileSync(
  join(app, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>Kerf connects to your Silhouette cutter over Bluetooth to send cut jobs from Figma.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
      <key>CFBundleURLSchemes</key><array><string>kerf</string></array>
    </dict>
  </array>
</dict>
</plist>
`,
);

// Swift launcher, one slice per architecture.
const swiftArch = { arm64: "arm64", x64: "x86_64" };
const slices = arches.map((arch) => {
  const out = join(here, "build", `${EXECUTABLE}-${arch}`);
  run("xcrun", ["swiftc", "-O", "-target", `${swiftArch[arch]}-apple-macos13.0`, join(here, "src/main.swift"), "-o", out]);
  return out;
});
run("lipo", ["-create", ...slices, "-output", join(app, "Contents/MacOS", EXECUTABLE)]);
for (const s of slices) rmSync(s);

// Icons.
const icons = join(here, "build", "icons");
rmSync(icons, { recursive: true, force: true });
run("xcrun", ["swift", join(here, "src/make-icons.swift"), icons]);
run("iconutil", ["-c", "icns", join(icons, "AppIcon.iconset"), "-o", join(app, "Contents/Resources/AppIcon.icns")]);
for (const f of ["MenuBarIcon.png", "MenuBarIcon@2x.png"]) cpSync(join(icons, f), join(app, "Contents/Resources", f));
rmSync(icons, { recursive: true });

// Node.
const nodes = [];
for (const arch of arches) nodes.push(await officialNode(arch));
run("lipo", ["-create", ...nodes, "-output", join(app, "Contents/Helpers/node")]);

// Helper script and runtime modules.
const helperDir = join(app, "Contents/Resources/helper");
cpSync(script, join(helperDir, "main.js"));
writeFileSync(join(helperDir, "package.json"), JSON.stringify({ type: "module", private: true }));
for (const name of RUNTIME_MODULES)
  cpSync(join(nodeModules, name), join(helperDir, "node_modules", name), {
    recursive: true,
    dereference: true,
    // Only the macOS prebuilt binding is needed.
    filter: (src) => !/[\\/]prebuilds[\\/](?!darwin)[^\\/]+/.test(src),
  });

// ---------- signing ----------

// Hardened runtime everywhere. V8 needs JIT; ad-hoc signatures have no team, so the native addon can only
// be loaded with library validation off.
const entitlements = join(here, "build", "node.entitlements");
writeFileSync(
  entitlements,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  ${identity === "-" ? "<key>com.apple.security.cs.disable-library-validation</key><true/>" : ""}
</dict>
</plist>
`,
);
const sign = (path, extra = []) =>
  run("codesign", ["--force", "--sign", identity, "--options", "runtime", ...(developerId ? ["--timestamp"] : []), ...extra, path]);

console.log(`Signing with ${identity === "-" ? "an ad-hoc signature" : identity}`);
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const file of walk(helperDir).filter((f) => f.endsWith(".node"))) sign(file); // inside out
sign(join(app, "Contents/Helpers/node"), ["--entitlements", entitlements]);
sign(app);
rmSync(entitlements);
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`Built ${app} (${arches.join(" + ")}, ${output("du", ["-sh", app]).split("\t")[0]})`);

// ---------- notarization ----------

if (notaryProfile) {
  const zip = join(here, "build", `Kerf-${VERSION}.zip`);
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  run("xcrun", ["notarytool", "submit", zip, "--keychain-profile", notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", app]);
  rmSync(zip);
  run("ditto", ["-c", "-k", "--keepParent", app, zip]); // re-zip with the stapled ticket
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  console.log(`Notarized: ${zip}`);
}

// ---------- install ----------

if (args.includes("--install")) {
  const target = join(homedir(), "Applications", `${NAME}.app`);
  mkdirSync(dirname(target), { recursive: true });
  // Quit a running copy (its helper disconnects from the cutter) so the new build takes its place.
  try {
    execFileSync("osascript", ["-e", `quit app "${NAME}"`], { stdio: "ignore" });
  } catch {}
  const running = () => {
    try {
      execFileSync("pgrep", ["-f", `${NAME}.app/Contents/`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && running(); i++) execFileSync("sleep", ["0.2"]);
  rmSync(target, { recursive: true, force: true });
  cpSync(app, target, { recursive: true });
  // Register the kerf:// scheme with Launch Services, then start the app.
  run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", target]);
  run("open", [target]);
  console.log(`Installed and opened ${target}`);
}
