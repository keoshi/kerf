// Per-model specs for Silhouette cutters that speak GP-GL over Bluetooth LE.
//
// Model names come from the firmware images bundled with Silhouette Studio 5
// (SPEC_CUTTER/firmware/*), whose identity strings are e.g. "CAMEO 4" + " PLUS" / " PRO"; the
// firmware query (FG) answers "<name> V<major>.<minor>", e.g. "CAMEO 4 V1.20".
// Sizes are the manufacturer's nominal cutting widths and standard mats. Only models marked
// `verified` have been tested with this project; see CONTRIBUTING.md to help verify others.

export interface CutterModel {
  id: string;
  /** Display name, as the firmware reports it. */
  name: string;
  /** Widest cut across the feed direction. */
  widthMm: number;
  /** The mat the model ships with (used for "New mat" in the Figma plugin). */
  matMm: { width: number; height: number };
  /** Longest cut along the feed direction (roll media). */
  maxLengthMm: number;
  /** Tested end to end with this project. */
  verified: boolean;
}

const IN = 25.4;
/** Inches → mm, without float noise (12 × 25.4 = 304.79999…). */
const mm = (inches: number) => Math.round(inches * IN * 100) / 100;
const ROLL = mm(120); // 10 ft

const model = (id: string, name: string, widthIn: number, mat: [number, number], maxLengthMm: number, verified = false): CutterModel => ({
  id,
  name,
  widthMm: mm(widthIn),
  matMm: { width: mm(mat[0]), height: mm(mat[1]) },
  maxLengthMm,
  verified,
});

export const MODELS: CutterModel[] = [
  model("cameo4", "CAMEO 4", 12, [12, 12], ROLL, true),
  model("cameo4plus", "CAMEO 4 PLUS", 15, [15, 15], ROLL),
  model("cameo4pro", "CAMEO 4 PRO", 24, [24, 24], ROLL),
  model("cameo5", "CAMEO 5", 12, [12, 12], ROLL),
  model("cameo5plus", "CAMEO 5 PLUS", 15, [15, 15], ROLL),
  model("cameo5pro", "CAMEO 5 PRO", 24, [24, 24], ROLL),
  model("cameo5alpha", "CAMEO 5 ALPHA", 12, [12, 12], ROLL),
  model("cameo5alphaplus", "CAMEO 5 ALPHA PLUS", 15, [15, 15], ROLL),
  model("cameopro2", "CAMEO PRO MARK2", 24, [24, 24], ROLL),
  model("portrait3", "PORTRAIT 3", 8, [8, 12], ROLL),
  model("portrait4", "PORTRAIT 4", 8, [8, 12], ROLL),
  model("curio2", "CURIO 2", 8.5, [8.5, 12], mm(12)),
];

/** Used until a cutter has identified itself. */
export const DEFAULT_MODEL: CutterModel = MODELS[0]!;

const normalise = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

/** "CAMEO 4 PLUS V1.20" → CAMEO 4 PLUS. */
export function modelFromFirmware(firmware: string): CutterModel | null {
  const name = normalise(firmware).replace(/\s+V\d+(\.\d+)*$/, "");
  return MODELS.find((m) => m.name === name) ?? null;
}

/** "CAMEO 4-700181A" → CAMEO 4. Advertised names end in a serial suffix after the last dash. */
export function modelFromBluetoothName(bleName: string): CutterModel | null {
  const name = normalise(bleName).replace(/-[0-9A-F]+$/, "");
  return MODELS.find((m) => m.name === name) ?? null;
}

/** Best guess from whatever the cutter has told us so far; the firmware reply wins. */
export function identifyModel(firmware: string | null, bleName: string | null): CutterModel | null {
  return (firmware && modelFromFirmware(firmware)) || (bleName && modelFromBluetoothName(bleName)) || null;
}

/** Advertised name prefixes of Bluetooth-capable Silhouette cutters. */
export const BLUETOOTH_NAME_PREFIXES = ["CAMEO", "PORTRAIT", "CURIO", "SILHOUETTE"];
