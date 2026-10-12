import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildJob,
  decodeStatus,
  describeBytes,
  encodeCommands,
  identifyModel,
  invert,
  JobBoundsError,
  MODELS,
  multiply,
  orderInsideOut,
  parseCutRequest,
  parsePathData,
  scale,
  toPolylines,
  type Transform,
} from "../src/index.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("parses Figma-style absolute path data into closed polylines", () => {
  const lines = toPolylines(parsePathData("M 0 0 L 20 0 L 20 20 L 0 20 Z"));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
    { x: 0, y: 0 },
  ]);
});

test("handles relative, H/V and implicit lineto commands", () => {
  const [line] = toPolylines(parsePathData("m10 10 5 0 v5 h-5z"));
  assert.deepEqual(line, [
    { x: 10, y: 10 },
    { x: 15, y: 10 },
    { x: 15, y: 15 },
    { x: 10, y: 15 },
    { x: 10, y: 10 },
  ]);
});

test("splits multiple subpaths (e.g. a shape with a hole)", () => {
  const lines = toPolylines(parsePathData("M0 0H10V10H0Z M2 2H8V8H2Z"));
  assert.equal(lines.length, 2);
});

test("flattens a cubic within tolerance", () => {
  // Quarter circle of radius 10 (kappa approximation).
  const k = 0.5522847498 * 10;
  const [line] = toPolylines(parsePathData(`M10 0 C10 ${k} ${k} 10 0 10`), undefined, 0.01);
  assert.ok(line!.length > 4);
  for (const p of line!) close(Math.hypot(p.x, p.y), 10, 0.05);
  assert.deepEqual(line!.at(-1), { x: 0, y: 10 });
});

test("transforms compose and invert", () => {
  const m: Transform = [
    [0, -1, 5],
    [1, 0, 7],
  ];
  const id = multiply(invert(m), m);
  close(id[0][0], 1);
  close(id[0][1], 0);
  close(id[0][2], 0);
  close(id[1][1], 1);
  const [line] = toPolylines(parsePathData("M1 0 L2 0"), multiply(scale(2), m));
  assert.deepEqual(line, [
    { x: 10, y: 16 },
    { x: 10, y: 18 },
  ]);
});

test("orders inner shapes before outer ones", () => {
  const outer = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const inner = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }];
  assert.deepEqual(orderInsideOut([outer, inner]), [inner, outer]);
});

test("builds the Studio-equivalent job for a 20 mm square", () => {
  const square = toPolylines(parsePathData("M10 10 H30 V30 H10 Z"));
  const cmds = buildJob(square, { force: 10, speed: 5, depth: 1, passes: 1, blade: "autoblade" });
  assert.deepEqual(cmds, [
    "FN0", "TB50,0", "J1", "FX10,1", "TJ3", "!5,1", "FC0,1,1", "FE0,1", "FF1,1,1", "FF1,1,1",
    "FX10,1", "TJ3", "FC18,1,1", "TF1,1",
    // y,x order, 20 steps per mm
    "M200,200", "D200,600", "D600,600", "D600,200", "D200,200",
    "L0", "\\0,0", "M0,0", "J1", "FN0", "TB50,0",
  ]);
  assert.equal(describeBytes(encodeCommands(["FN0", "J1"])), "FN0⏎J1⏎");
});

test("repeats each path for multiple passes and omits depth for manual blades", () => {
  const line = [[{ x: 0, y: 0 }, { x: 1, y: 0 }]];
  const cmds = buildJob(line, { force: 33, speed: 1, depth: 5, passes: 2, blade: "manual" });
  assert.ok(!cmds.some((c) => c.startsWith("TF")));
  assert.equal(cmds.filter((c) => c === "M0,0").length, 3); // 2 passes + trailer
});

test("clamps settings to the Cameo 4 ranges", () => {
  const cmds = buildJob([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], { force: 99, speed: 0, depth: 42, passes: 1, blade: "autoblade" });
  assert.ok(cmds.includes("FX33,1"));
  assert.ok(cmds.includes("!1,1"));
  assert.ok(cmds.includes("TF10,1"));
});

test("rejects geometry outside the mat", () => {
  assert.throws(
    () => buildJob([[{ x: 0, y: 0 }, { x: 400, y: 0 }]], { force: 10, speed: 5, depth: 1, passes: 1, blade: "autoblade" }),
    JobBoundsError,
  );
});

test("uses the detected model's cutting width", () => {
  const wide = [[{ x: 0, y: 0 }, { x: 500, y: 0 }]];
  const opts = { force: 10, speed: 5, depth: 1, passes: 1, blade: "autoblade" as const };
  assert.throws(() => buildJob(wide, { ...opts, model: identifyModel("CAMEO 4 PLUS V1.20", null)! }), JobBoundsError);
  assert.ok(buildJob(wide, { ...opts, model: identifyModel("CAMEO 4 PRO V1.20", null)! }).length > 0);
});

test("identifies models from firmware replies and Bluetooth names", () => {
  assert.equal(identifyModel("CAMEO 4 V1.20", "CAMEO 4-700181A")?.id, "cameo4");
  assert.equal(identifyModel("CAMEO 5 ALPHA PLUS V1.04", null)?.id, "cameo5alphaplus");
  assert.equal(identifyModel(null, "PORTRAIT 4-1A2B3C")?.id, "portrait4");
  assert.equal(identifyModel("CAMEO 4 PLUS V1.20", "CAMEO 4-ABC")?.id, "cameo4plus"); // firmware wins
  assert.equal(identifyModel("Something else", "Unknown"), null);
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
});

test("decodes status replies", () => {
  assert.equal(decodeStatus("0\x03"), "ready");
  assert.equal(decodeStatus("1\x03"), "moving");
  assert.equal(decodeStatus("2\x03"), "unloaded");
  assert.equal(decodeStatus("??"), "unknown");
});

test("validates cut requests", () => {
  const ok = parseCutRequest({
    paths: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]],
    settings: { force: 10, speed: 5, depth: 1, passes: 1 },
  });
  assert.equal(ok.blade, "autoblade");
  assert.throws(() => parseCutRequest({ paths: [], settings: {} }));
  assert.throws(() => parseCutRequest({ paths: [[{ x: "a", y: 0 }, { x: 1, y: 1 }]], settings: { force: 1, speed: 1, depth: 1, passes: 1 } }));
});
