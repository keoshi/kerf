// Cameo 4 Bluetooth LE protocol, independent of any BLE library.
// UUIDs and characteristic roles were decompiled from Silhouette Studio's BluetoothIO.dylib and
// match inkscape-silhouette's BLETransport and bob-takuya/cameo-cut.

export const BLE = {
  service: "e2088282-4fde-42f9-bb22-6ec3c7ed8f91",
  /** Notifies movement events ("1⏎" moving, "0⏎" idle). */
  status: "61490654-b5b4-458c-a867-9e15bc1471e0",
  /** Notifies replies to queries (ESC ENQ, FG, …). */
  read: "8dcf199a-30e7-4bd4-beb6-beb57dca866c",
  /** Command stream, written with response. */
  write: "6d92661d-f429-4d67-929b-28e7a9780912",
  /** Conservative ATT payload; Studio sends up to ~39 bytes once the MTU is negotiated. */
  defaultChunkSize: 20,
} as const;

const ESC = 0x1b;

export const Escape = {
  /** ESC EOT: initialise. Sent to every characteristic during the handshake. */
  init: Uint8Array.of(ESC, 0x04),
  /** ESC ENQ: status query → "0⏎" ready, "1⏎" moving, "2⏎" no media loaded. */
  status: Uint8Array.of(ESC, 0x05),
  /** ESC NAK: tool setup query (Cameo 4). */
  tools: Uint8Array.of(ESC, 0x15),
} as const;

export type CutterState = "ready" | "moving" | "unloaded" | "unknown";

export function decodeStatus(reply: string): CutterState {
  const code = reply.replace(/\x03$/, "").trim();
  if (code === "0") return "ready";
  if (code === "1") return "moving";
  if (code === "2") return "unloaded";
  return "unknown";
}

/** Tool codes reported by the Cameo 4 (from inkscape-silhouette). */
export const TOOL_NAMES: Record<number, string> = {
  0: "empty",
  1: "ratchet blade",
  2: "AutoBlade",
  3: "deep-cut blade",
  4: "Kraft blade",
  5: "rotary blade",
  7: "pen",
  255: "error",
};

export function* chunk(bytes: Uint8Array, size: number = BLE.defaultChunkSize): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
