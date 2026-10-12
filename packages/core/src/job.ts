// The request a client (Figma plugin, web companion) sends to a cutter driver (local helper, Web Bluetooth).

import type { Polyline } from "./geometry.ts";
import type { BladeKind } from "./gpgl.ts";
import type { CutSettings } from "./materials.ts";

export interface CutRequest {
  /** Polylines in millimetres; origin = top-left corner of the mat's cutting area. */
  paths: Polyline[];
  settings: CutSettings;
  blade: BladeKind;
  /** Free-form label shown in the helper log (e.g. Figma frame name). */
  label?: string;
}

export class InvalidRequestError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate untrusted JSON into a CutRequest. */
export function parseCutRequest(input: unknown): CutRequest {
  const fail = (msg: string): never => {
    throw new InvalidRequestError(msg);
  };
  if (typeof input !== "object" || input === null) fail("Request body must be a JSON object");
  const body = input as Record<string, unknown>;

  if (!Array.isArray(body.paths) || body.paths.length === 0) fail("`paths` must be a non-empty array");
  const paths = (body.paths as unknown[]).map((line, i) => {
    if (!Array.isArray(line) || line.length < 2) fail(`paths[${i}] needs at least two points`);
    return (line as unknown[]).map((p, j) => {
      const pt = p as { x?: unknown; y?: unknown };
      if (typeof p !== "object" || p === null || !isNum(pt.x) || !isNum(pt.y)) fail(`paths[${i}][${j}] must be {x, y} numbers`);
      return { x: pt.x as number, y: pt.y as number };
    });
  });

  const s = body.settings as Record<string, unknown> | undefined;
  if (!s || !isNum(s.force) || !isNum(s.speed) || !isNum(s.depth) || !isNum(s.passes))
    fail("`settings` needs numeric force, speed, depth and passes");

  const blade = body.blade ?? "autoblade";
  if (blade !== "autoblade" && blade !== "manual") fail("`blade` must be \"autoblade\" or \"manual\"");

  return {
    paths,
    settings: { force: s!.force as number, speed: s!.speed as number, depth: s!.depth as number, passes: s!.passes as number },
    blade: blade as BladeKind,
    label: typeof body.label === "string" ? body.label.slice(0, 200) : undefined,
  };
}

export const pointCount = (paths: Polyline[]) => paths.reduce((n, l) => n + l.length, 0);
