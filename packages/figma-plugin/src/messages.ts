import type { BladeKind, CutSettings, Polyline } from "@kerf/core";

/** How many millimetres one Figma unit represents. */
export type UnitScale = "mm" | "px96" | "pt72";

export const MM_PER_UNIT: Record<UnitScale, number> = {
  mm: 1,
  px96: 25.4 / 96,
  pt72: 25.4 / 72,
};

export const UNIT_LABELS: Record<UnitScale, string> = {
  mm: "1 unit = 1 mm",
  px96: "1 unit = 1 px (96 dpi)",
  pt72: "1 unit = 1 pt (72 dpi)",
};

export interface Prefs {
  unit: UnitScale;
  materialId: string;
  /** Overrides for the selected material, or full custom values. */
  settings: CutSettings;
  blade: BladeKind;
}

/** A top-level layer of the selection (or of the mat), cut or skipped as a whole. */
export interface CutObject {
  id: string;
  name: string;
  paths: Polyline[];
}

export interface Selection {
  objects: CutObject[];
  /** The top-level frame used as the mat (origin = its top-left corner). */
  mat: { name: string; widthMm: number; heightMm: number } | null;
  label: string;
  skipped: number;
  errors: string[];
}

export type ToUi = { type: "init"; prefs: Prefs | null } | { type: "selection"; selection: Selection };

export type ToPlugin =
  | { type: "prefs"; prefs: Prefs }
  | { type: "create-mat"; name: string; widthMm: number; heightMm: number }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "resize"; height: number };
