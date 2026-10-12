// Plugin UI: shows the selection, lets you pick a material, and talks to the local helper over HTTP.

import {
  bounds,
  type CutRequest,
  type CutSettings,
  type CutterModel,
  DEFAULT_MODEL,
  MATERIALS,
} from "@kerf/core";
import { type Prefs, type Selection, type ToPlugin, type ToUi, UNIT_LABELS, type UnitScale } from "./messages.ts";

const HELPER = "http://localhost:47821";
/** Retry connecting to the cutter this often while the plugin is open. */
const RECONNECT_MS = 15_000;
const CUSTOM = "custom";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  dot: $("dot"),
  statusText: $("status-text"),
  connect: $<HTMLButtonElement>("connect"),
  helperHint: $("helper-hint"),
  cutterHint: $("cutter-hint"),
  preview: $("preview"),
  summary: $("summary"),
  warnings: $("warnings"),
  material: $<HTMLSelectElement>("material"),
  force: $<HTMLInputElement>("force"),
  speed: $<HTMLInputElement>("speed"),
  depth: $<HTMLInputElement>("depth"),
  passes: $<HTMLInputElement>("passes"),
  blade: $<HTMLSelectElement>("blade"),
  unit: $<HTMLSelectElement>("unit"),
  createMat: $<HTMLButtonElement>("create-mat"),
  dryRun: $<HTMLButtonElement>("dry-run"),
  cut: $<HTMLButtonElement>("cut"),
  cancel: $<HTMLButtonElement>("cancel"),
  job: $("job"),
  progress: $("progress"),
  jobText: $("job-text"),
  commandsBox: $<HTMLDetailsElement>("commands-box"),
  commands: $("commands"),
};

interface HelperStatus {
  helper: { version: string; dryRun: boolean };
  cutter: {
    connection: string;
    name: string | null;
    firmware: string | null;
    state: string | null;
    model: CutterModel | null;
    error: string | null;
  } | null;
  job: {
    state: string;
    sentBytes: number;
    totalBytes: number;
    error: string | null;
    label: string | null;
    dryRun: boolean;
    finishedAt: string | null;
  } | null;
}

let prefs: Prefs = {
  unit: "mm",
  materialId: MATERIALS[0]!.id,
  settings: pick(MATERIALS[0]!),
  blade: "autoblade",
};
let selection: Selection | null = null;
let helper: HelperStatus | null = null;
let lastConnectAttempt = 0;

/** The connected (or last seen) cutter's model; the Cameo 4 until one has identified itself. */
let model: CutterModel = DEFAULT_MODEL;

function pick({ force, speed, depth, passes }: CutSettings): CutSettings {
  return { force, speed, depth, passes };
}

const toPlugin = (msg: ToPlugin) => parent.postMessage({ pluginMessage: msg }, "*");

// ---------- settings form ----------

for (const m of MATERIALS) el.material.add(new Option(m.name, m.id));
el.material.add(new Option("Custom", CUSTOM));
for (const [value, label] of Object.entries(UNIT_LABELS)) el.unit.add(new Option(label, value));

function renderPrefs() {
  el.material.value = prefs.materialId;
  el.force.value = String(prefs.settings.force);
  el.speed.value = String(prefs.settings.speed);
  el.depth.value = String(prefs.settings.depth);
  el.passes.value = String(prefs.settings.passes);
  el.blade.value = prefs.blade;
  el.depth.disabled = prefs.blade !== "autoblade";
  el.unit.value = prefs.unit;
}

function savePrefs() {
  renderPrefs();
  toPlugin({ type: "prefs", prefs });
}

el.material.addEventListener("change", () => {
  const m = MATERIALS.find((m) => m.id === el.material.value);
  prefs = { ...prefs, materialId: el.material.value, settings: m ? pick(m) : prefs.settings };
  savePrefs();
});
for (const key of ["force", "speed", "depth", "passes"] as const) {
  el[key].addEventListener("change", () => {
    const value = Number(el[key].value);
    if (!Number.isFinite(value)) return renderPrefs();
    const settings = { ...prefs.settings, [key]: value };
    const preset = MATERIALS.find((m) => JSON.stringify(pick(m)) === JSON.stringify(settings));
    prefs = { ...prefs, settings, materialId: preset?.id ?? CUSTOM };
    savePrefs();
  });
}
el.blade.addEventListener("change", () => {
  prefs = { ...prefs, blade: el.blade.value as Prefs["blade"] };
  savePrefs();
});
el.unit.addEventListener("change", () => {
  prefs = { ...prefs, unit: el.unit.value as UnitScale };
  savePrefs();
});
el.createMat.addEventListener("click", () =>
  toPlugin({ type: "create-mat", name: model.name, widthMm: model.matMm.width, heightMm: model.matMm.height }),
);

// ---------- selection preview ----------

/** Layer ids the user switched off by clicking them in the preview. Kept across selection changes. */
const disabled = new Set<string>();

const enabledPaths = () => (selection?.objects ?? []).filter((o) => !disabled.has(o.id)).flatMap((o) => o.paths);

function renderSelection() {
  const sel = selection;
  const objects = sel?.objects ?? [];
  const paths = enabledPaths();
  const all = bounds(objects.flatMap((o) => o.paths));
  const b = bounds(paths);
  const warnings: string[] = [...(sel?.errors ?? [])];

  if (!sel || !all) {
    el.summary.textContent = sel?.skipped ? "The selection has no cuttable shapes." : "Select shapes to cut.";
    el.preview.innerHTML = "";
  } else {
    if (!b) {
      el.summary.textContent = "Everything is switched off. Click a shape in the preview to include it.";
    } else {
      const w = (b.maxX - b.minX).toFixed(1);
      const h = (b.maxY - b.minY).toFixed(1);
      const where = sel.mat ? `on “${sel.mat.name}”, ${b.minX.toFixed(1)} mm from left, ${b.minY.toFixed(1)} mm from top` : "origin at selection corner";
      const off = objects.filter((o) => disabled.has(o.id)).length;
      const count = off ? `${objects.length - off} of ${objects.length} objects` : `${objects.length} object${objects.length === 1 ? "" : "s"}`;
      el.summary.textContent = `${count} · ${w} × ${h} mm · ${where}`;
      if (b.minX < 0 || b.minY < 0) warnings.push("Some shapes stick out above or left of the mat.");
      if (b.maxX > model.widthMm)
        warnings.push(`Some shapes are beyond the ${model.name}'s ${+model.widthMm.toFixed(1)} mm cutting width.`);
    }
    if (sel.skipped) warnings.push(`${sel.skipped} layer(s) without geometry were skipped.`);
    el.preview.innerHTML = previewSvg(sel, all);
  }
  el.warnings.textContent = warnings.join(" ");
  updateButtons();
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function previewSvg(sel: Selection, b: NonNullable<ReturnType<typeof bounds>>): string {
  const matW = sel.mat ? sel.mat.widthMm : model.widthMm;
  const matH = sel.mat ? sel.mat.heightMm : Math.max(b.maxY, 50);
  const minX = Math.min(0, b.minX) - 4;
  const minY = Math.min(0, b.minY) - 4;
  const vw = Math.max(matW, b.maxX) - minX + 4;
  const vh = Math.max(matH, b.maxY) - minY + 4;
  const stroke = Math.max(vw, vh) / 300;
  const pad = stroke * 3;

  // Larger objects first, so smaller ones sitting on top of them stay clickable.
  const objects = sel.objects
    .map((o) => ({ o, ob: bounds(o.paths)! }))
    .sort((a, z) => (z.ob.maxX - z.ob.minX) * (z.ob.maxY - z.ob.minY) - (a.ob.maxX - a.ob.minX) * (a.ob.maxY - a.ob.minY));
  const groups = objects
    .map(({ o, ob }) => {
      const lines = o.paths
        .map((l) => `<polyline points="${l.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")}"/>`)
        .join("");
      const off = disabled.has(o.id);
      return `<g class="object${off ? " off" : ""}" data-id="${escape(o.id)}">
        <title>${escape(o.name)}${off ? " (off, click to include)" : " (click to skip)"}</title>
        <rect class="hit" x="${ob.minX - pad}" y="${ob.minY - pad}" width="${ob.maxX - ob.minX + 2 * pad}"
          height="${ob.maxY - ob.minY + 2 * pad}" rx="${pad}"/>${lines}</g>`;
    })
    .join("");
  return `<svg viewBox="${minX} ${minY} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="${Math.min(matW, model.widthMm)}" height="${matH}" fill="var(--figma-color-bg, #fff)"
      stroke="var(--figma-color-border, #ccc)" stroke-width="${stroke}"/>
    <g fill="none" stroke="var(--figma-color-text, #000)" stroke-width="${stroke * 1.5}" stroke-linejoin="round">${groups}</g>
  </svg>`;
}

el.preview.addEventListener("click", (event) => {
  const id = (event.target as Element).closest<SVGGElement>(".object")?.dataset.id;
  if (!id) return;
  if (disabled.has(id)) disabled.delete(id);
  else disabled.add(id);
  renderSelection();
});

// ---------- helper connection ----------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(HELPER + path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

async function poll() {
  try {
    helper = await api<HelperStatus>("/status");
  } catch {
    helper = null;
  }
  const c = helper?.cutter;
  // Connect automatically while the plugin is open; the helper lets go of the cutter once we close.
  if (c?.connection === "disconnected" && Date.now() - lastConnectAttempt > RECONNECT_MS) connect();
  if (c?.model && c.model.id !== model.id) {
    model = c.model;
    renderSelection();
  }
  renderHelper();
  setTimeout(poll, jobRunning() ? 400 : 1200);
}

const STATE_TEXT: Record<string, string> = {
  ready: "Ready",
  moving: "Moving",
  unloaded: "No mat loaded",
  unknown: "Unknown state",
};

function renderHelper() {
  const c = helper?.cutter;
  let dot = "bad";
  let text = "Helper not running";
  el.helperHint.hidden = helper !== null;
  el.connect.hidden = true;
  el.cutterHint.textContent = "";

  if (helper?.helper.dryRun) {
    dot = "warn";
    text = "Helper in dry-run mode (nothing is sent)";
  } else if (helper && c) {
    if (c.connection === "connected") {
      dot = c.state === "ready" ? "ok" : "warn";
      text = `${c.name ?? "Cutter"} · ${STATE_TEXT[c.state ?? "unknown"] ?? c.state}`;
      if (!c.model) el.cutterHint.textContent = "Unknown model: using CAMEO 4 limits. Please report it on GitHub.";
      else if (!c.model.verified) el.cutterHint.textContent = `${c.model.name} isn't verified yet. Test on scrap first, and please report how it goes.`;
    } else if (c.connection === "scanning" || c.connection === "connecting") {
      dot = "warn";
      text = c.connection === "scanning" ? "Looking for the cutter…" : `Connecting to ${c.name ?? "the cutter"}…`;
    } else {
      dot = "warn";
      text = "Cutter not connected";
      el.connect.hidden = false;
      if (c.error) el.cutterHint.textContent = c.error;
    }
  }
  el.dot.className = `dot ${dot}`;
  el.statusText.textContent = text;
  renderJob();
  updateButtons();
}

/** Finished and stopped jobs stay on screen this long; failures stay until the next job. */
const JOB_LINGER_MS = 4000;

const jobRunning = () => ["sending", "cutting", "cancelling"].includes(helper?.job?.state ?? "");

function renderJob() {
  const job = helper?.job;
  el.cancel.hidden = job?.state !== "sending" && job?.state !== "cutting";
  const faded =
    (job?.state === "done" || job?.state === "cancelled") &&
    job.finishedAt !== null &&
    Date.now() - Date.parse(job.finishedAt) > JOB_LINGER_MS;
  if (!job || job.dryRun || faded) {
    el.job.hidden = true;
    return;
  }
  el.job.hidden = false;
  const pct = job.totalBytes ? Math.round((job.sentBytes / job.totalBytes) * 100) : 0;
  (el.progress as HTMLElement).style.width = `${job.state === "done" ? 100 : pct}%`;
  const text: Record<string, string> = {
    sending: `Sending… ${pct}%`,
    cutting: "Cutting… waiting for the cutter to finish",
    cancelling: "Stopping… resetting the cutter",
    done: "Done ✓",
    failed: `Failed: ${job.error ?? "unknown error"}`,
    cancelled: job.error ? `Stopped, but: ${job.error}` : "Stopped. The cutter was reset.",
  };
  el.jobText.textContent = text[job.state] ?? job.state;
  el.jobText.className = job.state === "failed" ? "error" : "muted";
}

function updateButtons() {
  const hasPaths = enabledPaths().length > 0;
  const running = jobRunning();
  el.dryRun.disabled = !hasPaths || !helper;
  el.cut.disabled = !hasPaths || !helper || running || helper.helper.dryRun;
}

function request(): CutRequest {
  return { paths: enabledPaths(), settings: prefs.settings, blade: prefs.blade, label: selection!.label };
}

function connect() {
  lastConnectAttempt = Date.now();
  api("/connect", { method: "POST", body: "{}" }).catch(showError);
}

el.connect.addEventListener("click", connect);

el.cancel.addEventListener("click", () => {
  el.cancel.hidden = true;
  api("/jobs/cancel", { method: "POST", body: "{}" }).catch(showError);
});

el.dryRun.addEventListener("click", async () => {
  try {
    const { job } = await api<{ job: { commands: string; totalBytes: number } }>("/jobs?dryRun=1", {
      method: "POST",
      body: JSON.stringify(request()),
    });
    el.commands.textContent = job.commands;
    el.commandsBox.hidden = false;
    el.commandsBox.open = true;
  } catch (err) {
    showError(err);
  }
});

el.cut.addEventListener("click", async () => {
  el.cut.disabled = true;
  try {
    await api("/jobs", { method: "POST", body: JSON.stringify(request()) });
    toPlugin({ type: "notify", message: "Sending to the Cameo…" });
  } catch (err) {
    showError(err);
  }
});

function showError(err: unknown) {
  toPlugin({ type: "notify", message: err instanceof Error ? err.message : String(err), error: true });
}

// ---------- plugin messages ----------

window.onmessage = (event: MessageEvent<{ pluginMessage?: ToUi }>) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === "init") {
    if (msg.prefs) prefs = { ...prefs, ...msg.prefs };
    renderPrefs();
  } else if (msg.type === "selection") {
    selection = msg.selection;
    renderSelection();
  }
};

// Size the plugin window to the content (it changes with the helper hint, job progress and commands).
new ResizeObserver(() => toPlugin({ type: "resize", height: document.body.scrollHeight })).observe(document.body);

renderPrefs();
poll();
