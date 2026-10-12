// Plugin main thread: turns the current selection into millimetre polylines for the UI.
//
// Coordinates are relative to the "mat": the top-level frame containing the selection
// (its top-left corner is the cutter origin). Without a frame, the selection's own
// top-left corner becomes the origin.

import {
  bounds,
  invert,
  multiply,
  parsePathData,
  type Polyline,
  scale,
  toPolylines,
  type Transform,
} from "@kerf/core";
import { type CutObject, MM_PER_UNIT, type Prefs, type Selection, type ToPlugin, type ToUi, type UnitScale } from "./messages.ts";

const PREFS_KEY = "prefs-v1";

const UI_WIDTH = 360;
figma.showUI(__html__, { width: UI_WIDTH, height: 640, themeColors: true });

let unit: UnitScale = "mm";

const post = (msg: ToUi) => figma.ui.postMessage(msg);

const CONTAINERS = new Set<NodeType>(["GROUP", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

/** Top-level frame-like ancestor (child of the page), if any. */
function findMat(node: SceneNode): FrameNode | ComponentNode | InstanceNode | null {
  let top: BaseNode = node;
  while (top.parent && top.parent.type !== "PAGE" && top.parent.type !== "DOCUMENT") top = top.parent;
  return top.type === "FRAME" || top.type === "COMPONENT" || top.type === "INSTANCE" ? top : null;
}

/** Visible leaf nodes with geometry; boolean operations count as one shape. */
function collectLeaves(node: SceneNode, out: SceneNode[]): void {
  if (!node.visible) return;
  if (node.type === "BOOLEAN_OPERATION") out.push(node);
  else if (CONTAINERS.has(node.type) && "children" in node) for (const child of node.children) collectLeaves(child, out);
  else out.push(node);
}

/** SVG path data for a node, in its local coordinate space. */
function pathData(node: SceneNode): string[] | null {
  if (node.type === "LINE") return [`M 0 0 L ${node.width} 0`];
  if (node.type === "VECTOR") {
    // Open vector paths have no fill geometry; use the authored paths.
    const filled = Array.isArray(node.fills) && node.fills.some((f) => f.visible !== false);
    if (!filled || node.fillGeometry.length === 0) return node.vectorPaths.map((p) => p.data);
  }
  if ("fillGeometry" in node && node.fillGeometry.length > 0) return node.fillGeometry.map((p) => p.data);
  return null;
}

function asTransform(t: Transform): Transform {
  return [
    [t[0][0], t[0][1], t[0][2]],
    [t[1][0], t[1][1], t[1][2]],
  ];
}

function readSelection(): Selection {
  const selection = figma.currentPage.selection;
  const empty: Selection = { objects: [], mat: null, label: "", skipped: 0, errors: [] };
  if (selection.length === 0) return empty;

  // Selecting the mat frame itself means "cut everything on it".
  const roots = selection.length === 1 && findMat(selection[0]!) === selection[0] ? [...(selection[0] as FrameNode).children] : selection;
  const mat = findMat(selection[0]!);
  const mmPerUnit = MM_PER_UNIT[unit];
  const toMat: Transform = mat ? multiply(scale(mmPerUnit), invert(asTransform(mat.absoluteTransform))) : scale(mmPerUnit);

  const objects: CutObject[] = [];
  const errors: string[] = [];
  let skipped = 0;
  for (const root of roots) {
    const leaves: SceneNode[] = [];
    collectLeaves(root, leaves);
    const paths: Polyline[] = [];
    for (const node of leaves) {
      const data = pathData(node);
      if (!data) {
        skipped++;
        continue;
      }
      const m = multiply(toMat, asTransform(node.absoluteTransform));
      for (const d of data) {
        try {
          paths.push(...toPolylines(parsePathData(d), m, 0.025));
        } catch (err) {
          errors.push(`${node.name}: ${(err as Error).message}`);
        }
      }
    }
    if (paths.length) objects.push({ id: root.id, name: root.name, paths });
  }

  // Without a mat, shift so the selection's top-left corner is the origin.
  if (!mat) {
    const b = bounds(objects.flatMap((o) => o.paths));
    if (b) for (const o of objects) for (const line of o.paths) for (const p of line) (p.x -= b.minX), (p.y -= b.minY);
  }

  return {
    objects,
    mat: mat ? { name: mat.name, widthMm: mat.width * mmPerUnit, heightMm: mat.height * mmPerUnit } : null,
    label: mat ? mat.name : selection.map((n) => n.name).join(", "),
    skipped,
    errors,
  };
}

let pending: ReturnType<typeof setTimeout> | undefined;
function refresh() {
  clearTimeout(pending);
  pending = setTimeout(() => post({ type: "selection", selection: readSelection() }), 60);
}

/** A frame the size of the cutter's standard mat, e.g. 12"×12" for the Cameo 4. */
async function createMat(model: string, widthMm: number, heightMm: number) {
  const unitsPerMm = 1 / MM_PER_UNIT[unit];
  const inches = (mm: number) => +(mm / 25.4).toFixed(1);
  const frame = figma.createFrame();
  frame.name = `${model} mat ${inches(widthMm)}"×${inches(heightMm)}"`;
  frame.resize(widthMm * unitsPerMm, heightMm * unitsPerMm);
  frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  frame.strokes = [{ type: "SOLID", color: { r: 0.36, g: 0.73, b: 0.86 } }];
  frame.clipsContent = true;
  const center = figma.viewport.center;
  frame.x = Math.round(center.x - frame.width / 2);
  frame.y = Math.round(center.y - frame.height / 2);
  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.notify("Mat created. Put your cut shapes inside it.");
}

figma.ui.onmessage = async (msg: ToPlugin) => {
  switch (msg.type) {
    case "prefs":
      await figma.clientStorage.setAsync(PREFS_KEY, msg.prefs);
      if (msg.prefs.unit !== unit) {
        unit = msg.prefs.unit;
        refresh();
      }
      break;
    case "create-mat":
      await createMat(msg.name, msg.widthMm, msg.heightMm);
      break;
    case "resize":
      // The UI reports its content height; keep the window snug around it.
      figma.ui.resize(UI_WIDTH, Math.min(900, Math.max(200, Math.ceil(msg.height))));
      break;
    case "notify":
      figma.notify(msg.message, { error: msg.error });
      break;
  }
};

// With dynamic page loading, listen to edits on the current page only (documentchange would
// require loading every page first).
let watchedPage = figma.currentPage;
watchedPage.on("nodechange", refresh);
figma.on("currentpagechange", () => {
  watchedPage.off("nodechange", refresh);
  watchedPage = figma.currentPage;
  watchedPage.on("nodechange", refresh);
  refresh();
});
figma.on("selectionchange", refresh);

(async () => {
  const prefs = ((await figma.clientStorage.getAsync(PREFS_KEY)) as Prefs | undefined) ?? null;
  if (prefs) unit = prefs.unit;
  post({ type: "init", prefs });
  refresh();
})();
