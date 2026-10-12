// Cut settings use Silhouette Studio's scales for the Cameo 4:
// force 1–33 (FX), speed 1–30 (!), AutoBlade depth 0–10 (TF), passes ≥ 1.

export interface CutSettings {
  force: number;
  speed: number;
  /** AutoBlade depth; ignored for manual (ratchet) blades. */
  depth: number;
  passes: number;
}

export interface Material extends CutSettings {
  id: string;
  name: string;
  /** Where the numbers come from, so they can be re-checked. */
  source: "studio" | "cameo-cut";
}

export const LIMITS = {
  force: { min: 1, max: 33 },
  speed: { min: 1, max: 30 },
  depth: { min: 0, max: 10 },
  passes: { min: 1, max: 10 },
} as const;

/**
 * Presets seeded from bob-takuya/cameo-cut `resources/presets.json`
 * (MIT License, Copyright (c) 2026 bob-takuya), plus values read off Silhouette Studio 5.0
 * for a Cameo 4. cameo-cut's "vinyl" matched Studio's Vinyl, Matte exactly.
 */
export const MATERIALS: Material[] = [
  { id: "vinyl-matte", name: "Vinyl, Matte", force: 10, speed: 5, depth: 1, passes: 1, source: "studio" },
  { id: "htv", name: "Heat Transfer Vinyl", force: 15, speed: 8, depth: 2, passes: 1, source: "cameo-cut" },
  { id: "paper", name: "Print Paper", force: 15, speed: 10, depth: 2, passes: 1, source: "cameo-cut" },
  { id: "cardstock", name: "Cardstock", force: 20, speed: 4, depth: 3, passes: 1, source: "cameo-cut" },
  { id: "cardstock-thick", name: "Thick Cardstock (200gsm+)", force: 25, speed: 3, depth: 4, passes: 1, source: "cameo-cut" },
  { id: "kraft", name: "Kraft Paper", force: 20, speed: 3, depth: 3, passes: 1, source: "cameo-cut" },
  { id: "sticker", name: "Sticker Paper", force: 20, speed: 5, depth: 2, passes: 1, source: "cameo-cut" },
  { id: "clear-sticker", name: "Clear Sticker", force: 33, speed: 4, depth: 3, passes: 2, source: "cameo-cut" },
  { id: "fabric", name: "Fabric (with stabilizer)", force: 33, speed: 5, depth: 5, passes: 1, source: "cameo-cut" },
  { id: "chipboard", name: "Chipboard (thin)", force: 33, speed: 1, depth: 5, passes: 2, source: "cameo-cut" },
  { id: "magnet", name: "Adhesive Magnet", force: 33, speed: 1, depth: 6, passes: 2, source: "cameo-cut" },
  { id: "score", name: "Score Line (light)", force: 10, speed: 8, depth: 1, passes: 1, source: "cameo-cut" },
];

const clamp = (v: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(v)));

export function clampSettings(s: CutSettings): CutSettings {
  return {
    force: clamp(s.force, LIMITS.force),
    speed: clamp(s.speed, LIMITS.speed),
    depth: clamp(s.depth, LIMITS.depth),
    passes: clamp(s.passes, LIMITS.passes),
  };
}
