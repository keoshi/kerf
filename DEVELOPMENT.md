# Developing Kerf

For installing and using Kerf, see the [README](README.md). To help test cutters, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How it fits together

```
Figma plugin ──HTTP (localhost:47821)──▶ Kerf helper ──Bluetooth LE──▶ cutter
```

| Package | What it does |
|---|---|
| `packages/core` | Transport-agnostic logic: path flattening, GP-GL job building, materials, cutter models, BLE protocol. No dependencies, so it can also run in a browser (Web Bluetooth) later. |
| `packages/helper` | Node app that owns the Bluetooth connection and exposes a small local API. |
| `packages/helper-app` | **Kerf for Silhouette.app**, a macOS menu-bar app that bundles Node and the helper and keeps it running. |
| `packages/figma-plugin` | The Figma plugin: reads the selection, previews it, sends jobs to the helper. |

How the cutter protocol was worked out is documented in [`docs/silhouette-studio-findings.md`](docs/silhouette-studio-findings.md).

## Setup

Requires Node 22.18+; the app needs macOS and Xcode.

```sh
npm install
npm run build
npm test            # core unit tests
npm run typecheck
npm run watch -w @kerf/figma-plugin
```

Run from source:

- `npm run helper` / `npm run probe`: the helper from this checkout.
- `npm run install-cli`: link a global `kerf` to this checkout.
- `npm run app`: build **Kerf for Silhouette.app**, install it to `~/Applications` and open it.
- In Figma, import `packages/figma-plugin/manifest.json`.

Helper options for development: `--dry-run` never touches Bluetooth (jobs are only encoded and logged),
`--port <n>` changes the HTTP port, and `--chunk <bytes>` changes the BLE write size (default 20).

## Building the app

`node packages/helper-app/build.mjs [options]` bundles the official Node.js build (downloaded from nodejs.org and
checksum-verified) with the helper.

- `--install`: copy to `~/Applications` and open it (what `npm run app` does).
- `--universal`: Apple Silicon + Intel.
- `--identity "<name>"`: signing identity. The default is the first **Developer ID Application** certificate, else
  **Apple Development**, else an ad-hoc signature. With an ad-hoc signature, macOS asks for Bluetooth permission again
  after every rebuild.
- `--notarize <profile>`: notarize and staple, with a Developer ID certificate and a `notarytool` keychain profile
  (`xcrun notarytool store-credentials <profile> --apple-id <you> --team-id <team>`).

Only Developer ID signed and notarized builds open without warnings on other Macs.

## Releasing

```sh
node tools/release.mjs        # → release/: Kerf-for-Silhouette.zip, kerf-helper.tgz, Kerf-Figma-plugin.zip
gh release create v<version> release/* --title "Kerf <version>"
```

File names carry no version, so the `releases/latest/download/…` links in the README always point at the newest release.

## Other tools

- `tools/parse_bt_log.py` decodes Silhouette Studio's Bluetooth traffic from the macOS unified log
  (needs Apple's Bluetooth logging profile). See the findings doc.
- `tools/store/make-assets.mjs` renders the Figma Community images in `docs/store/`.

## Helper API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/status` | | helper, cutter (`connection`, `name`, `firmware`, `tools`, `state`, `model`, `error`) and current job |
| POST | `/connect` | `{ "name"?: string }` | scan + connect in the background; poll `/status` |
| POST | `/disconnect` | | |
| POST | `/jobs[?dryRun=1]` | `CutRequest` (see `packages/core/src/job.ts`) | 202 + job; dry runs return the command text |
| POST | `/jobs/cancel` | | stops sending, then resets the cutter (ESC EOT) so it drops buffered commands |

- Binds to `127.0.0.1` only.
- Releases the cutter after 30 s without requests; the plugin polls `/status` while open and calls `/connect` as needed.
- Browser requests are accepted only from Figma origins, including the plugin iframe's `null` origin.
- Requests with an `X-Kerf-Passive` header (the menu-bar app's status line) don't keep the cutter connected.
