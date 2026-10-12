import { randomUUID } from "node:crypto";
import {
  assertInBounds,
  buildJob,
  DEFAULT_MODEL,
  type CutRequest,
  describeBytes,
  encodeCommands,
  orderInsideOut,
  pointCount,
} from "@kerf/core";
import type { Cameo } from "./cameo.ts";
import { log } from "./log.ts";

/** "cancelling": the cutter is being reset after a stop request. */
export type JobState = "sending" | "cutting" | "cancelling" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  label: string | null;
  dryRun: boolean;
  state: JobState;
  paths: number;
  points: number;
  sentBytes: number;
  totalBytes: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Human-readable command stream; only kept for dry runs. */
  commands: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JobRunner {
  current: JobRecord | null = null;
  private cancelRequested = false;

  private readonly cameo: Cameo | null;
  private readonly cutterName: string | undefined;

  constructor(cameo: Cameo | null, cutterName?: string) {
    this.cameo = cameo;
    this.cutterName = cutterName;
  }

  get busy(): boolean {
    const state = this.current?.state;
    return state === "sending" || state === "cutting" || state === "cancelling";
  }

  /** Validate and encode now (so errors return synchronously), then run in the background. */
  start(request: CutRequest, dryRun: boolean): JobRecord {
    if (this.busy) throw new Error("A job is already running");
    const paths = orderInsideOut(request.paths);
    // Until a cutter has identified itself, check against the Cameo 4; run() re-checks after connecting.
    const model = this.cameo?.model ?? DEFAULT_MODEL;
    const commands = buildJob(paths, { ...request.settings, blade: request.blade, model });
    const bytes = encodeCommands(commands);
    const job: JobRecord = {
      id: randomUUID(),
      label: request.label ?? null,
      dryRun,
      state: dryRun ? "done" : "sending",
      paths: paths.length,
      points: pointCount(paths),
      sentBytes: dryRun ? bytes.length : 0,
      totalBytes: bytes.length,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: dryRun ? new Date().toISOString() : null,
      commands: dryRun ? describeBytes(bytes) : null,
    };
    this.current = job;
    const what = `${job.paths} paths, ${job.points} points, ${job.totalBytes} bytes`;
    if (dryRun) {
      log(`Dry run "${job.label ?? job.id}": ${what}\n${job.commands}`);
      return job;
    }
    log(`Job "${job.label ?? job.id}": ${what}`);
    this.cancelRequested = false;
    this.run(job, bytes, paths).catch(() => {});
    return job;
  }

  /** Stop sending and reset the cutter; run() notices the flag and does the reset. */
  cancel(): boolean {
    const job = this.current;
    if (!job || (job.state !== "sending" && job.state !== "cutting")) return false;
    this.cancelRequested = true;
    log(`Stopping "${job.label ?? job.id}"`);
    return true;
  }

  private finish(job: JobRecord, state: JobState, error?: unknown) {
    job.state = state;
    job.error = error ? (error instanceof Error ? error.message : String(error)) : null;
    job.finishedAt = new Date().toISOString();
    log(`Job ${state}${job.error ? `: ${job.error}` : ""}`, state === "failed" ? "error" : "info");
  }

  private async run(job: JobRecord, bytes: Uint8Array, paths: CutRequest["paths"]): Promise<void> {
    const cameo = this.cameo;
    try {
      if (!cameo) throw new Error("Helper is in dry-run mode");
      if (cameo.connection === "disconnected") await cameo.connect({ name: this.cutterName });
      if (cameo.model) assertInBounds(paths, cameo.model);
      const state = await cameo.refreshStatus();
      if (state === "unloaded") throw new Error("No mat loaded: load the mat on the Cameo first");
      if (state === "moving") throw new Error("The cutter is busy");

      let moved = false;
      const onMove = (moving: boolean) => (moved ||= moving);
      cameo.on("movement", onMove);
      try {
        await cameo.sendJob(
          bytes,
          (sent) => (job.sentBytes = sent),
          () => this.cancelRequested,
        );
        job.state = "cutting";

        // Wait for the head to finish: "moving" first, then "ready" again.
        const sentAt = Date.now();
        for (;;) {
          await sleep(1000);
          if (this.cancelRequested) throw new Error("Cancelled");
          const s = await cameo.refreshStatus().catch(() => null);
          if (s === "moving") moved = true;
          if (s === "ready" && (moved || Date.now() - sentAt > 10_000)) break;
          if (Date.now() - sentAt > 60 * 60_000) throw new Error("Timed out waiting for the cut to finish");
        }
      } finally {
        cameo.off("movement", onMove);
      }
      this.finish(job, "done");
    } catch (err) {
      if (!this.cancelRequested || !cameo || cameo.connection !== "connected") {
        this.finish(job, this.cancelRequested ? "cancelled" : "failed", err);
        return;
      }
      // Stopped by the user: discard what the cutter still has buffered and reset it.
      job.state = "cancelling";
      try {
        const state = await cameo.abort();
        this.finish(job, "cancelled", state === "ready" || state === "unloaded" ? undefined : "The cutter didn't report ready after the reset");
      } catch (resetErr) {
        this.finish(job, "failed", resetErr);
      }
    }
  }
}
