import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { InvalidRequestError, JobBoundsError, parseCutRequest } from "@kerf/core";
import type { Cameo } from "./cameo.ts";
import type { JobRunner } from "./jobs.ts";
import { log } from "./log.ts";

export const DEFAULT_PORT = 47821;
const VERSION = "0.1.0";
const MAX_BODY = 10 * 1024 * 1024;

// Figma plugin UIs run in a sandboxed iframe whose Origin is "null".
// Requests without an Origin header (curl, local scripts) are allowed too.
const ALLOWED_ORIGINS = new Set(["null", "https://www.figma.com", "https://figma.com"]);

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!(req.headers["content-type"] ?? "").includes("application/json"))
      return reject(new HttpError(415, "Content-Type must be application/json"));
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Request too large"));
        req.destroy();
      } else parts.push(b);
    });
    req.on("end", () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {});
      } catch {
        reject(new HttpError(400, "Body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Exit code when the port is taken, so a supervisor (the menu-bar app) doesn't keep restarting us. */
export const EXIT_PORT_IN_USE = 3;

/** Requests carrying this header don't keep the cutter connected. */
export const PASSIVE_HEADER = "x-kerf-passive";

export function startServer(opts: {
  port: number;
  cameo: Cameo | null;
  jobs: JobRunner;
  cutterName?: string;
  /** Called on every request, so the helper can tell whether a client (the plugin) is still around. */
  onActivity?: () => void;
}) {
  const { cameo, jobs } = opts;

  const status = () => ({
    helper: { version: VERSION, dryRun: cameo === null },
    cutter: cameo?.info() ?? null,
    job: jobs.current,
  });

  const server = createServer(async (req, res) => {
    // Observers (the menu-bar app's status line) don't count as someone wanting the cutter.
    if (req.headers[PASSIVE_HEADER] === undefined) opts.onActivity?.();
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: `Origin ${origin} not allowed` });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        // Chrome's Private Network Access preflight for requests from https pages to localhost.
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /status":
          return send(res, 200, status());

        case "POST /connect": {
          if (!cameo) throw new HttpError(409, "Helper is running in dry-run mode");
          const body = (await readJson(req)) as { name?: unknown };
          const name = typeof body.name === "string" ? body.name : opts.cutterName;
          // Connecting can take a while (scan + handshake); report progress through /status.
          cameo.connect({ name }).catch((err) => log(`Connect failed: ${err.message}`, "error"));
          return send(res, 202, status());
        }

        case "POST /disconnect":
          if (jobs.busy) throw new HttpError(409, "A job is running");
          await cameo?.disconnect();
          return send(res, 200, status());

        case "POST /jobs": {
          const request = parseCutRequest(await readJson(req));
          const dryRun = cameo === null || url.searchParams.get("dryRun") === "1";
          const job = jobs.start(request, dryRun);
          return send(res, dryRun ? 200 : 202, { job });
        }

        case "POST /jobs/cancel":
          return send(res, 200, { cancelled: jobs.cancel(), job: jobs.current });

        default:
          throw new HttpError(404, `No route for ${route}`);
      }
    } catch (err) {
      const statusCode =
        err instanceof HttpError
          ? err.status
          : err instanceof InvalidRequestError || err instanceof JobBoundsError
            ? 400
            : err instanceof Error && err.message.includes("already running")
              ? 409
              : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (statusCode >= 500) log(`${route} failed: ${message}`, "error");
      return send(res, statusCode, { error: message });
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    log(`Port ${opts.port} is in use: another helper is probably running already`, "error");
    process.exit(EXIT_PORT_IN_USE);
  });
  server.listen(opts.port, "127.0.0.1", () => log(`Helper listening on http://localhost:${opts.port}`));
  return server;
}
