#!/usr/bin/env node
import { BLE } from "@kerf/core";
import { Cameo } from "./cameo.ts";
import { JobRunner } from "./jobs.ts";
import { log } from "./log.ts";
import { DEFAULT_PORT, startServer } from "./server.ts";

/** Release the cutter after this long without requests from any client. */
const IDLE_MS = 30_000;

const USAGE = `Usage: kerf [serve|probe] [options]

Commands:
  serve (default)   Run the local API the Figma plugin talks to
  probe             Connect, print firmware / tools / status, disconnect. Never moves the cutter.

Options:
  --port <n>        HTTP port (default ${DEFAULT_PORT})
  --name <name>     Exact Bluetooth name, e.g. "CAMEO 4-700181A" (default: first Silhouette cutter found)
  --chunk <bytes>   BLE write size (default ${BLE.defaultChunkSize})
  --dry-run         No Bluetooth: jobs are encoded and logged, never sent
  --verbose         Log every byte received from the cutter

The cutter is connected on demand (when the Figma plugin is open or a job arrives) and released
${IDLE_MS / 1000} s after the last request, so Silhouette Studio can use it in between.`;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function probe(cameo: Cameo, name?: string) {
  await cameo.connect({ name });
  const { name: found, firmware, tools, state, model } = cameo.info();
  const report = {
    name: found,
    firmware,
    tools,
    state,
    model: model ? { id: model.id, name: model.name, verified: model.verified } : "unknown",
    helper: "0.1.0",
    os: `${process.platform} ${process.arch}`,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!model?.verified)
    console.log("\nThis model isn't verified yet. Please share the output above: see CONTRIBUTING.md.");
  await cameo.disconnect();
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return console.log(USAGE);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "serve";
  const name = option("--name");
  const port = Number(option("--port") ?? DEFAULT_PORT);
  const dryRun = args.includes("--dry-run");
  const cameo = dryRun ? null : new Cameo(Number(option("--chunk") ?? BLE.defaultChunkSize));

  if (command === "probe") {
    if (!cameo) throw new Error("probe needs Bluetooth; drop --dry-run");
    return probe(cameo, name);
  }
  if (command !== "serve") throw new Error(`Unknown command "${command}"\n\n${USAGE}`);

  const jobs = new JobRunner(cameo, name);
  let lastActivity = Date.now();
  startServer({ port, cameo, jobs, cutterName: name, onActivity: () => (lastActivity = Date.now()) });
  if (dryRun) log("Dry-run mode: jobs are encoded and logged, never sent to a cutter");

  // While a client is around, keep the cutter state fresh like Studio does; once nobody has asked
  // for a while, let go of the cutter so other apps can connect to it.
  if (cameo)
    setInterval(() => {
      if (cameo.connection !== "connected" || jobs.busy) return;
      if (Date.now() - lastActivity > IDLE_MS) {
        log("No requests for a while; releasing the cutter");
        cameo.disconnect().catch(() => {});
      } else cameo.refreshStatus().catch(() => {});
    }, 3000).unref();

  const shutdown = async () => {
    await cameo?.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err), "error");
  process.exit(1);
});
