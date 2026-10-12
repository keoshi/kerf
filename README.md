# Kerf

**Cut Figma designs on a Silhouette cutter** over Bluetooth, without Silhouette Studio.

Verified on the **CAMEO 4**. Other Bluetooth models (CAMEO 4 Plus/Pro, CAMEO 5 family, Portrait 3/4, Curio 2) are
detected and use their own cutting width and mat size, but are untested: see [CONTRIBUTING.md](CONTRIBUTING.md) to help.

Kerf is an independent project, not affiliated with Silhouette America or Figma.

```
Figma plugin ──HTTP (localhost:47821)──▶ Kerf helper ──Bluetooth LE──▶ cutter
```

| Package | What it does |
|---|---|
| `packages/core` | Transport-agnostic logic: path flattening, GP-GL job building, materials, cutter models, BLE protocol. No dependencies, so it can also run in a browser (Web Bluetooth) later. |
| `packages/helper` | Node app that owns the Bluetooth connection and exposes a small local API. |
| `packages/helper-app` | **Kerf for Silhouette.app**, a macOS menu-bar app that bundles Node and the helper and keeps it running. |
| `packages/figma-plugin` | The Figma plugin: reads the selection, previews it, sends jobs to the helper. |

How the protocol was worked out is documented in [`docs/silhouette-studio-findings.md`](docs/silhouette-studio-findings.md).

## Setup

Requires Node 22.18+ to build, and macOS for the app. Linux/Windows should work for the terminal helper via noble,
but are untested.

```sh
npm install
npm run build
```

**Quit Silhouette Studio before cutting from Figma.** The cutter stops advertising while Studio is connected to it.

There are two ways to run the helper. Use one at a time: both listen on the same port.

### Option A: the Kerf app (macOS)

```sh
npm run app
```

This builds **Kerf for Silhouette.app**, copies it to `~/Applications` and opens it. It lives in the menu bar (blade icon):

- Allow Bluetooth when macOS asks.
- Turn on **Open at Login** in its menu if you want it always available. It's off by default.
- The cutter is connected only while the plugin is open, and released ~30 s after you close it,
  so Silhouette Studio can still use it in between.
- Log: menu → **Open Log** (`~/Library/Logs/Kerf/helper.log`).

The app is self-contained: it bundles the official Node.js build (downloaded from nodejs.org and checksum-verified)
and the helper, so it doesn't depend on your Node install.

Build options (`node packages/helper-app/build.mjs …`):

- `--install`: copy to `~/Applications` and open it (what `npm run app` does).
- `--universal`: Apple Silicon + Intel.
- `--identity "<name>"`: signing identity. The default is the first **Developer ID Application** certificate, else
  **Apple Development**, else an ad-hoc signature. With an ad-hoc signature, macOS asks for Bluetooth permission again
  after every rebuild.
- `--notarize <profile>`: notarize and staple. This needs a Developer ID certificate and a `notarytool` keychain profile:
  `xcrun notarytool store-credentials <profile> --apple-id <you> --team-id <team>`.

Only a **Developer ID** signed and **notarized** build opens without warnings on other Macs. Apple Development and ad-hoc
builds are for the Mac that built them.

Release build (universal, signed with Developer ID, notarized and stapled):

```sh
npm run build -w @kerf/helper
node packages/helper-app/build.mjs --universal --notarize kerf-notary
# → packages/helper-app/build/Kerf-<version>.zip, ready to share
```

### Option B: a terminal, no app

For anyone who'd rather not install an app, or isn't on macOS. Install the `kerf` command once, from this folder:

```sh
npm run install-cli   # builds the helper and links a global `kerf` command (npm install -g ./packages/helper)
```

Then, from any folder:

```sh
kerf probe    # connect, print firmware/tools/status/model, disconnect (never moves the cutter)
kerf          # run the local API for the plugin; Ctrl-C to stop
```

Without installing, `npm run probe` and `npm run helper` do the same from this folder.

- Quit the Kerf app first (menu → Quit Kerf); only one helper can run at a time.
- The first run asks macOS for Bluetooth permission for your terminal app.
- Options, e.g. `kerf --name "CAMEO 4-700181A"` (with npm: `npm run helper -- --name …`):
  - `--name` picks a specific cutter
  - `--verbose` logs every reply
  - `--dry-run` never touches Bluetooth; jobs are only encoded and logged
  - `--chunk <bytes>` changes the BLE write size (default 20)

### 2. Load the plugin in Figma

Figma desktop → **Plugins → Development → Import plugin from manifest…** → `packages/figma-plugin/manifest.json`.

## Using it

1. **New mat** creates a frame the size of your cutter's standard mat (12″×12″ for the Cameo 4).
   Its top-left corner is the mat's top-left corner on the cutter.
   Any top-level frame works as a mat; without one, the selection's top-left becomes the origin.
2. Put shapes, text or vectors inside the frame and select them, or select the frame to cut everything on it.
   - Filled shapes are cut along their outline, holes included.
   - Open vector paths are cut along the path.
   - Text is cut as outlines.
3. Click a shape in the preview to skip it (it turns semi-transparent); click again to include it.
   Each top-level layer counts as one object, e.g. a group or a text layer.
4. Pick a material, or adjust force / speed / depth / passes. Values use Silhouette Studio's scales.
5. **Units** sets how Figma units map to millimetres (default 1 unit = 1 mm).
6. **Preview commands** shows the exact GP-GL stream. **Cut** sends it.

**Stop** halts a running job. The helper stops sending and resets the cutter, which drops whatever it had buffered,
so the cutter is ready for the next job.

Inner shapes are cut before the shapes that contain them. Multiple passes repeat each path back-to-back.

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

## Development

```sh
npm test            # core unit tests
npm run typecheck
npm run watch -w @kerf/figma-plugin
```

`tools/parse_bt_log.py` decodes Silhouette Studio's Bluetooth traffic from the macOS unified log
(needs Apple's Bluetooth logging profile). See the findings doc.

## Contributing

Owners of other Silhouette models can help a lot with a 2-minute read-only probe. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- BLE handshake, write pacing and the seed material presets come from
  [bob-takuya/cameo-cut](https://github.com/bob-takuya/cameo-cut) (MIT).
- Protocol details were cross-checked against
  [fablabnbg/inkscape-silhouette](https://github.com/fablabnbg/inkscape-silhouette) (GPL-2.0, used as a reference only; no code copied).

## License

[MIT](LICENSE).
