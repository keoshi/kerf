type Level = "info" | "warn" | "error" | "debug";

const verbose = process.argv.includes("--verbose") || process.env.DEBUG === "1";

export function log(message: string, level: Level = "info"): void {
  if (level === "debug" && !verbose) return;
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = `${time} ${level === "info" ? "" : level.toUpperCase() + " "}${message}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
