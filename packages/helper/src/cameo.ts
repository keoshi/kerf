// Bluetooth LE link to a Silhouette cutter (verified on the Cameo 4), using noble (CoreBluetooth on macOS).
// Connection handshake and write pacing follow bob-takuya/cameo-cut (MIT) and match the
// traffic captured from Silhouette Studio; see docs/silhouette-studio-findings.md.

import { EventEmitter } from "node:events";
import noble, { type Characteristic, type Peripheral } from "@stoprocent/noble";
import {
  BLE,
  BLUETOOTH_NAME_PREFIXES,
  chunk,
  type CutterModel,
  type CutterState,
  DEFAULT_MODEL,
  decodeStatus,
  describeBytes,
  Escape,
  identifyModel,
} from "@kerf/core";
import { log } from "./log.ts";

export type Connection = "disconnected" | "scanning" | "connecting" | "connected";

export interface CameoInfo {
  connection: Connection;
  name: string | null;
  firmware: string | null;
  tools: string | null;
  state: CutterState | null;
  /** Detected model; null until the cutter identifies itself or if it is unknown. */
  model: CutterModel | null;
  /** Why the last connection attempt failed, if it did. */
  error: string | null;
}

export interface CameoEvents {
  change: [];
  movement: [moving: boolean];
}

// noble wants lowercase UUIDs without dashes.
const nobleUuid = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();
const ETX = "\x03";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Cameo extends EventEmitter<CameoEvents> {
  connection: Connection = "disconnected";
  name: string | null = null;
  firmware: string | null = null;
  tools: string | null = null;
  state: CutterState | null = null;
  model: CutterModel | null = null;
  error: string | null = null;

  private peripheral: Peripheral | null = null;
  private writeChar: Characteristic | null = null;
  private rx = "";
  private rxWaiter: (() => void) | null = null;
  // All link I/O goes through this chain so queries never interleave with a job stream.
  private io: Promise<unknown> = Promise.resolve();

  private readonly chunkSize: number;

  constructor(chunkSize: number = BLE.defaultChunkSize) {
    super();
    this.chunkSize = chunkSize;
  }

  info(): CameoInfo {
    const { connection, name, firmware, tools, state, model, error } = this;
    return { connection, name, firmware, tools, state, model, error };
  }

  private set(patch: Partial<Pick<Cameo, "connection" | "name" | "firmware" | "tools" | "state" | "model" | "error">>) {
    Object.assign(this, patch);
    this.emit("change");
  }

  /** Scan for a cutter (by exact name if given, else the first Silhouette advertiser) and connect. */
  async connect(opts: { name?: string; timeoutMs?: number } = {}): Promise<void> {
    if (this.connection !== "disconnected") return;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    this.set({ connection: "scanning", error: null });
    try {
      await noble.waitForPoweredOnAsync(10_000);
      const peripheral = await this.scan(opts.name, timeoutMs);
      this.set({ connection: "connecting", name: peripheral.advertisement.localName || peripheral.id });
      log(`Connecting to ${this.name} (${peripheral.id})`);
      await peripheral.connectAsync();
      peripheral.once("disconnect", (reason) => this.onDisconnect(reason));

      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [nobleUuid(BLE.service)],
        [BLE.status, BLE.read, BLE.write].map(nobleUuid),
      );
      const byUuid = (uuid: string) => {
        const c = characteristics.find((c) => c.uuid === nobleUuid(uuid));
        if (!c) throw new Error(`${this.name} does not expose characteristic ${uuid}; it may use a different protocol`);
        return c;
      };
      const statusChar = byUuid(BLE.status);
      const readChar = byUuid(BLE.read);
      const writeChar = byUuid(BLE.write);

      statusChar.on("data", (data) => {
        const text = data.toString("latin1");
        log(`status ← ${describeBytes(data)}`, "debug");
        if (text.startsWith("1")) this.emit("movement", true);
        if (text.startsWith("0")) this.emit("movement", false);
      });
      readChar.on("data", (data) => {
        log(`read ← ${describeBytes(data)}`, "debug");
        this.rx += data.toString("latin1");
        this.rxWaiter?.();
      });
      await statusChar.subscribeAsync();
      await readChar.subscribeAsync();

      // Handshake: ESC EOT on every characteristic, then let the cutter settle.
      for (const c of [statusChar, readChar, writeChar]) await c.writeAsync(Buffer.from(Escape.init), false);
      await sleep(1000);
      this.rx = "";

      this.peripheral = peripheral;
      this.writeChar = writeChar;
      this.set({ connection: "connected" });

      const firmware = await this.query("FG" + ETX).catch(() => null);
      const tools = await this.queryBytes(Escape.tools).catch(() => null);
      const fw = firmware?.trim() || null;
      this.set({ firmware: fw, tools: tools?.trim() || null, model: identifyModel(fw, this.name) });
      await this.refreshStatus();
      log(`Connected: ${this.name}, firmware ${this.firmware ?? "?"}, tools ${this.tools ?? "?"}, ${this.state}`);
      if (!this.model) log(`Unknown model; using ${DEFAULT_MODEL.name} limits. Please report it (see CONTRIBUTING.md)`, "warn");
      else if (!this.model.verified) log(`${this.model.name} is not verified yet; please report how it goes (see CONTRIBUTING.md)`, "warn");
    } catch (err) {
      await this.disconnect().catch(() => {});
      this.set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async scan(name: string | undefined, timeoutMs: number): Promise<Peripheral> {
    log(name ? `Scanning for "${name}"…` : "Scanning for a Silhouette cutter…");
    const wanted = (p: Peripheral) => {
      const local = (p.advertisement.localName ?? "").toUpperCase();
      return name ? local === name.toUpperCase() : BLUETOOTH_NAME_PREFIXES.some((prefix) => local.startsWith(prefix));
    };
    return new Promise<Peripheral>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "No cutter found. Is it switched on with Bluetooth enabled, and is Silhouette Studio closed? " +
              "(The cutter stops advertising while another app is connected.)",
          ),
        );
      }, timeoutMs);
      const onDiscover = (p: Peripheral) => {
        if (!wanted(p)) return;
        cleanup();
        resolve(p);
      };
      const cleanup = () => {
        clearTimeout(timer);
        noble.removeListener("discover", onDiscover);
        noble.stopScanningAsync().catch(() => {});
      };
      noble.on("discover", onDiscover);
      // The cutter may not list its service UUID in advertisements, so scan unfiltered and match by name.
      noble.startScanningAsync([], false).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  private onDisconnect(reason: unknown) {
    if (!this.peripheral) return; // we disconnected on purpose
    log(`Cutter disconnected (${String(reason)})`, "warn");
    this.peripheral = null;
    this.writeChar = null;
    this.set({ connection: "disconnected", state: null });
  }

  async disconnect(): Promise<void> {
    const p = this.peripheral;
    this.peripheral = null;
    this.writeChar = null;
    noble.stopScanningAsync().catch(() => {});
    if (p && p.state === "connected") await p.disconnectAsync();
    this.set({ connection: "disconnected", state: null });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.io.then(task, task);
    this.io = run.catch(() => {});
    return run;
  }

  private async writeRaw(bytes: Uint8Array): Promise<void> {
    const c = this.writeChar;
    if (!c) throw new Error("Cutter is not connected");
    for (let attempt = 0; ; attempt++) {
      try {
        await c.writeAsync(Buffer.from(bytes), false);
        return;
      } catch (err) {
        // The cutter answers ATT "busy" when its buffer is full; back off and retry.
        if (attempt >= 5) throw err;
        log(`write retry ${attempt + 1}: ${(err as Error).message}`, "debug");
        await sleep(100 * (attempt + 1));
      }
    }
  }

  private async readReply(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.rx.includes(ETX)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out waiting for the cutter to reply");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.rxWaiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.rxWaiter = null;
    }
    const end = this.rx.indexOf(ETX);
    const reply = this.rx.slice(0, end);
    this.rx = this.rx.slice(end + 1);
    return reply;
  }

  /** Send raw bytes and wait for one ETX-terminated reply on the read characteristic. */
  queryBytes(bytes: Uint8Array, timeoutMs = 3000): Promise<string> {
    return this.enqueue(async () => {
      this.rx = "";
      await this.writeRaw(bytes);
      return this.readReply(timeoutMs);
    });
  }

  query(command: string, timeoutMs = 3000): Promise<string> {
    return this.queryBytes(new TextEncoder().encode(command), timeoutMs);
  }

  async refreshStatus(): Promise<CutterState> {
    const reply = await this.queryBytes(Escape.status);
    const state = decodeStatus(reply);
    if (state !== this.state) this.set({ state });
    return state;
  }

  /**
   * Stop whatever the cutter is doing: ESC EOT re-initialises it, which discards the commands it
   * has buffered and resets the head. Waits (up to `timeoutMs`) for it to report ready or unloaded again.
   * Must be called after the job stream has stopped (sendJob checks `shouldStop` between chunks).
   */
  async abort(timeoutMs = 30_000): Promise<CutterState | null> {
    await this.enqueue(() => this.writeRaw(Escape.init));
    const deadline = Date.now() + timeoutMs;
    let state: CutterState | null = null;
    while (Date.now() < deadline) {
      await sleep(500);
      state = await this.refreshStatus().catch(() => null);
      if (state === "ready" || state === "unloaded") break;
    }
    this.rx = "";
    return state;
  }

  /**
   * Stream a job to the cutter in write-with-response chunks.
   * `shouldStop` is checked between chunks; the cutter still finishes what it has buffered.
   */
  sendJob(bytes: Uint8Array, onProgress: (sent: number, total: number) => void, shouldStop: () => boolean): Promise<void> {
    return this.enqueue(async () => {
      let sent = 0;
      for (const part of chunk(bytes, this.chunkSize)) {
        if (shouldStop()) throw new Error("Cancelled");
        await this.writeRaw(part);
        sent += part.length;
        onProgress(sent, bytes.length);
      }
    });
  }
}
