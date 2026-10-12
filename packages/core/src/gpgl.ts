// Build Graphtec GP-GL command streams for Silhouette cutters (verified on the Cameo 4).
//
// The setup and trailer mirror what Silhouette Studio 5.0 sent to a Cameo 4 over BLE
// (see docs/silhouette-studio-findings.md, "Live capture"). Studio draws with an undocumented
// binary "BE" form; we use plain ASCII M/D, which the Cameo 4 also accepts.
//
// Coordinate convention: the cutter's first axis runs down the mat (feed direction), the second
// across it. Our polylines use Figma's x→right, y→down, so every command is emitted as "y,x".

import type { Polyline } from "./geometry.ts";
import { type CutSettings, clampSettings } from "./materials.ts";
import { type CutterModel, DEFAULT_MODEL } from "./models.ts";

export const ETX = 0x03;
export const SU_PER_MM = 20;

export type BladeKind = "autoblade" | "manual";

export interface JobOptions extends CutSettings {
  blade: BladeKind;
  /** Tool holder; only holder 1 accepts the AutoBlade. */
  holder?: 1 | 2;
  /** Blade tip offset compensation in mm (Studio sends 0.9 mm for the AutoBlade). */
  bladeOffsetMm?: number;
  /** Sets the cuttable area; defaults to the Cameo 4. */
  model?: CutterModel;
}

export const mmToSU = (mm: number) => Math.round(mm * SU_PER_MM);

function point(cmd: "M" | "D", xMm: number, yMm: number) {
  return `${cmd}${mmToSU(yMm)},${mmToSU(xMm)}`;
}

export class JobBoundsError extends Error {}

/** Check that every point lies on the model's cuttable area; throws JobBoundsError otherwise. */
export function assertInBounds(paths: Polyline[], model: CutterModel = DEFAULT_MODEL): void {
  const eps = 1e-6;
  const { widthMm, maxLengthMm } = model;
  for (const line of paths)
    for (const p of line)
      if (p.x < -eps || p.y < -eps || p.x > widthMm + eps || p.y > maxLengthMm + eps)
        throw new JobBoundsError(
          `Point (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) mm is outside the ${model.name}'s cutting area ` +
            `(0–${+widthMm.toFixed(1)} × 0–${+maxLengthMm.toFixed(1)} mm)`,
        );
}

export function setupCommands(opts: JobOptions): string[] {
  const s = clampSettings(opts);
  const h = opts.holder ?? 1;
  const offsetSU = mmToSU(opts.bladeOffsetMm ?? 0.9);
  const cmds = [
    "FN0",
    "TB50,0", // portrait
    `J${h}`,
    `FX${s.force},${h}`,
    "TJ3", // acceleration
    `!${s.speed},${h}`,
    `FC0,1,${h}`,
    `FE0,${h}`, // no lift at corners
    `FF1,1,${h}`,
    `FF1,1,${h}`,
    `FX${s.force},${h}`,
    "TJ3",
    `FC${offsetSU},1,${h}`,
  ];
  if (opts.blade === "autoblade") {
    if (h !== 1) throw new Error("The AutoBlade only works in tool holder 1");
    cmds.push(`TF${s.depth},${h}`);
  }
  return cmds;
}

export function pathCommands(paths: Polyline[], passes: number): string[] {
  const cmds: string[] = [];
  for (const line of paths) {
    // Repeat each path back-to-back so the material can't shift between passes.
    for (let pass = 0; pass < passes; pass++) {
      let last = "";
      line.forEach((p, i) => {
        const cmd = point(i === 0 ? "M" : "D", p.x, p.y);
        // Points closer than 0.05 mm collapse to the same step; skip the repeats.
        if (cmd.slice(1) !== last) cmds.push(cmd);
        last = cmd.slice(1);
      });
    }
  }
  return cmds;
}

/** Return the head to the origin and restore defaults, as Studio does after a job. */
export function trailerCommands(holder: 1 | 2 = 1): string[] {
  return ["L0", "\\0,0", "M0,0", `J${holder}`, "FN0", "TB50,0"];
}

export function buildJob(paths: Polyline[], opts: JobOptions): string[] {
  assertInBounds(paths, opts.model);
  const passes = clampSettings(opts).passes;
  return [...setupCommands(opts), ...pathCommands(paths, passes), ...trailerCommands(opts.holder ?? 1)];
}

/** ETX-terminate each command and concatenate into the byte stream sent to the cutter. */
export function encodeCommands(cmds: string[]): Uint8Array {
  const text = cmds.map((c) => c + String.fromCharCode(ETX)).join("");
  return new TextEncoder().encode(text);
}

/** Human-readable view of a byte stream (ETX → "⏎", ESC → "␛"). */
export function describeBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b === ETX) out += "⏎";
    else if (b === 0x1b) out += "␛";
    else if (b >= 32 && b < 127) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}
