// Renders the Figma Community listing images from the real plugin UI (packages/figma-plugin/dist/ui.html).
//
//   npm run build && node tools/store/make-assets.mjs
//
// The plugin UI is loaded in headless Chrome with a scripted helper (fetch is stubbed) and a sample sticker
// sheet sent the way the plugin's main thread would. Output: docs/store/*.png.
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePathData, toPolylines } from "../../packages/core/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "docs/store");
const tmp = join(root, "tools/store/.tmp");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(out, { recursive: true });
mkdirSync(tmp, { recursive: true });

// ---------- sample design: a sticker sheet on a 12"×12" mat (millimetres) ----------

const MAT = 304.8;
/** SVG path data in a 100×100 box (or any box), placed at (x, y) and scaled to `size` mm wide. */
function place(d, x, y, size, boxWidth = 100) {
  const s = size / boxWidth;
  return toPolylines(parsePathData(d), [[s, 0, x], [0, s, y]], 0.05);
}
const circle = (cx, cy, r) => {
  const k = 0.5523 * r;
  return `M ${cx + r} ${cy} C ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} C ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`;
};
const star = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 21 : 50;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)} ${(53 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M ${pts.join(" L ")} Z`;
})();
const SHAPES = {
  heart: "M50 90 C20 68 4 52 4 31 C4 15 16 5 30 5 C40 5 47 10 50 17 C53 10 60 5 70 5 C84 5 96 15 96 31 C96 52 80 68 50 90 Z",
  star,
  ring: `${circle(50, 50, 48)} ${circle(50, 50, 24)}`,
  bolt: "M60 2 L16 56 L45 56 L36 98 L84 38 L55 38 L67 2 Z",
  tag: `M14 10 L70 10 L96 50 L70 90 L14 90 C8 90 4 86 4 80 L4 20 C4 14 8 10 14 10 Z ${circle(72, 50, 7)}`,
  drop: "M50 4 C50 4 88 46 88 66 C88 86 71 98 50 98 C29 98 12 86 12 66 C12 46 50 4 50 4 Z",
};

const wordmark = execFileSync("xcrun", ["swift", join(root, "tools/store/text-path.swift"), "kerf", "Avenir Next Heavy", "100"], {
  encoding: "utf8",
});
const objects = [{ id: "1:1", name: "kerf", paths: place(wordmark, 70, 26, 165, 230) }];
const grid = [["heart", "star", "ring"], ["bolt", "tag", "drop"]];
grid.forEach((row, r) =>
  row.forEach((name, c) => objects.push({ id: `1:${2 + r * 3 + c}`, name, paths: place(SHAPES[name], 32 + c * 92, 118 + r * 88, 64) })),
);
const selection = {
  objects,
  mat: { name: "CAMEO 4 mat 12″×12″", widthMm: MAT, heightMm: MAT },
  label: "CAMEO 4 mat 12″×12″",
  skipped: 0,
  errors: [],
};

// ---------- plugin UI states ----------

const MODEL = { id: "cameo4", name: "CAMEO 4", widthMm: 304.8, matMm: { width: 304.8, height: 304.8 }, maxLengthMm: 3048, verified: true };
const cutter = { connection: "connected", name: "CAMEO 4-700181A", firmware: "CAMEO 4 V1.20", tools: "2, 0", state: "ready", model: MODEL, error: null };
const job = (state, sentBytes) => ({
  id: "x", label: selection.label, dryRun: false, state, paths: 9, points: 900, sentBytes, totalBytes: 9200,
  error: null, startedAt: new Date().toISOString(), finishedAt: null, commands: null,
});
const STATES = {
  ready: { status: { helper: { version: "0.1.0", dryRun: false }, cutter, job: null } },
  skip: { status: { helper: { version: "0.1.0", dryRun: false }, cutter, job: null }, skip: ["1:3", "1:6"] },
  cutting: { status: { helper: { version: "0.1.0", dryRun: false }, cutter: { ...cutter, state: "moving" }, job: job("sending", 5800) } },
  commands: { status: { helper: { version: "0.1.0", dryRun: false }, cutter, job: null }, commands: true, material: "sticker" },
};

const ui = readFileSync(join(root, "packages/figma-plugin/dist/ui.html"), "utf8");

function harness(name, state) {
  const stub = `<script>
    const STATE = ${JSON.stringify(state)};
    window.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/status") ? STATE.status : {}), { status: 200 });
    window.addEventListener("load", () => {
      const send = (pluginMessage) => window.postMessage({ pluginMessage }, "*");
      const material = STATE.material ?? "vinyl-matte";
      send({ type: "init", prefs: null });
      setTimeout(() => {
        document.getElementById("material").value = material;
        document.getElementById("material").dispatchEvent(new Event("change"));
        send({ type: "selection", selection: ${JSON.stringify(selection)} });
      }, 50);
      setTimeout(() => {
        for (const id of STATE.skip ?? []) document.querySelector('[data-id="' + id + '"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
        if (STATE.commands) document.getElementById("dry-run").click();
      }, 150);
    });
  </script>`;
  // Pin the plugin's 360 px width, as in Figma.
  const css = `<style>html, body { background: #fff; } body { width: 360px; } :root { color-scheme: light; }</style>`;
  const file = join(tmp, `${name}.html`);
  writeFileSync(file, ui.replace("<head>", `<head>${css}`).replace("<body>", `<body>${stub}`));
  return file;
}

// ---------- headless Chrome over the DevTools protocol (exact viewport sizes) ----------

const profile = join(tmp, "chrome-profile");
const browser = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let port;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try {
    port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  } catch {}
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function cdp(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))),
  );
}

/** Load a page at an exact CSS size and scale, wait, and screenshot `height` (or the page's own height). */
async function capture(url, file, { width, height, scale = 1, wait = 700 }) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: height ?? 1200, deviceScaleFactor: scale, mobile: false });
  await cdp("Page.navigate", { url });
  await sleep(wait);
  const h = height ?? (await cdp("Runtime.evaluate", { expression: "document.body.scrollHeight", returnByValue: true })).result.value;
  const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: h, scale: 1 } });
  writeFileSync(file, Buffer.from(data, "base64"));
  return h;
}

/** Screenshot the plugin UI (360 px wide, as in Figma) at its natural height, 2× scale. */
async function shoot(name, state) {
  const file = join(tmp, `${name}.png`);
  const height = await capture(pathToFileURL(harness(name, state)).href, file, { width: 360, scale: 2 });
  return { file, height };
}

// ---------- listing frames (1920×1080) ----------

/** The plugin window as Figma draws it: title bar + UI. */
const pluginWindow = (shot, scale = 1.25) => `
  <div class="window" style="width:${360 * scale}px">
    <div class="titlebar"><img src="${pathToFileURL(join(tmp, "icon.png")).href}"><span>Kerf: Cut on Silhouette</span><b>×</b></div>
    <img class="ui" src="${pathToFileURL(shot.file).href}" style="width:${360 * scale}px;height:${shot.height * scale}px">
  </div>`;

async function frame(name, { title, subtitle, body }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1920px; height: 1080px; overflow: hidden; font-family: Inter, -apple-system, system-ui, sans-serif;
      background: radial-gradient(circle at 75% 20%, #2c2f36 0, #17181c 70%); color: #fff; display: flex; align-items: center;
      padding: 0 120px; gap: 100px; }
    .text { flex: 1; }
    /* balance / pretty: no widows or runts in headlines and body copy. */
    h1 { font-size: 76px; line-height: 1.05; letter-spacing: -2px; font-weight: 800; text-wrap: balance; }
    h1 em { font-style: normal; color: #ff6b2b; }
    p { margin-top: 28px; font-size: 32px; line-height: 1.4; color: #b8bcc6; max-width: 760px; text-wrap: balance; }
    .window { border-radius: 14px; overflow: hidden; background: #fff; box-shadow: 0 40px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); }
    .titlebar { height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 18px; color: #111; font-size: 18px;
      font-weight: 600; border-bottom: 1px solid #e6e6e6; }
    .titlebar img { width: 26px; height: 26px; border-radius: 6px; }
    .titlebar span { flex: 1; }
    .titlebar b { font-weight: 400; color: #888; font-size: 24px; }
    .ui { display: block; }
    .stack { display: flex; gap: 40px; align-items: flex-start; }
  </style></head><body>
    <div class="text"><h1>${title}</h1><p>${subtitle}</p></div>
    ${body}
  </body></html>`;
  const file = join(tmp, `frame-${name}.html`);
  writeFileSync(file, html);
  await capture(pathToFileURL(file).href, join(out, `${name}.png`), { width: 1920, height: 1080 });
}

// Plugin icon (128×128) and a 512 version for the frames: the app icon drawn full-bleed.
execFileSync("xcrun", ["swift", join(root, "packages/helper-app/src/make-icons.swift"), tmp, "--plugin-icon"], { stdio: "ignore" });
execFileSync("sips", ["-z", "128", "128", join(tmp, "PluginIcon.png"), "--out", join(out, "icon-128.png")], { stdio: "ignore" });
execFileSync("sips", ["-z", "64", "64", join(tmp, "PluginIcon.png"), "--out", join(tmp, "icon.png")], { stdio: "ignore" });

const shots = {};
for (const [name, state] of Object.entries(STATES)) shots[name] = await shoot(name, state);

await frame("cover", {
  title: "Cut your Figma designs on a <em>Silhouette</em>.",
  subtitle: "Send shapes, text and vectors straight from Figma to your Silhouette cutter over Bluetooth. No exporting, no Silhouette Studio.",
  body: pluginWindow(shots.ready, 1.4),
});
await frame("1-preview", {
  title: "What you see is <em>what gets cut</em>.",
  subtitle: "Kerf previews your selection on the mat at real size. Shapes, holes, text and open paths are all cut along their outlines.",
  body: pluginWindow(shots.ready, 1.4),
});
await frame("2-skip", {
  title: "Click to <em>skip</em> anything.",
  subtitle: "Click a layer in the preview to leave it out of this cut. It stays in place on the mat; click again to bring it back.",
  body: pluginWindow(shots.skip, 1.4),
});
await frame("3-cut", {
  title: "Materials, force, speed, <em>cut</em>.",
  subtitle: "Pick a material preset or tune force, speed, blade depth and passes. Watch progress, and stop safely at any time.",
  body: pluginWindow(shots.cutting, 1.4),
});
await frame("4-commands", {
  title: "Open, documented, <em>yours</em>.",
  subtitle: "Preview the exact commands sent to the cutter. Kerf is open source (MIT) and runs entirely on your computer.",
  body: pluginWindow(shots.commands, 1.25),
});

ws.close();
browser.kill();
await sleep(300);
rmSync(tmp, { recursive: true, force: true });
console.log(`Listing images written to ${out}`);
