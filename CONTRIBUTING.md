# Contributing

Thanks for helping! The most valuable contribution right now is **testing on cutters we don't own**.
Only the **CAMEO 4** is verified. Every other model in [`packages/core/src/models.ts`](packages/core/src/models.ts) uses
the manufacturer's nominal sizes and the Cameo 4's commands, which may or may not be right.

| Model | Status |
|---|---|
| CAMEO 4 | ✅ verified |
| CAMEO 4 PLUS / PRO, CAMEO 5 / PLUS / PRO, CAMEO 5 ALPHA / ALPHA PLUS, CAMEO PRO MARK2, PORTRAIT 3 / 4, CURIO 2 | ❓ unverified: please help |

There are three levels of help. Each one is useful on its own, so stop wherever you're comfortable.

## Before you start

- **Quit Silhouette Studio.** The cutter stops advertising over Bluetooth while Studio is connected.
- Turn the cutter on and enable its Bluetooth.
- Install the `kerf` command (needs [Node.js](https://nodejs.org) 22.18+; macOS, Linux or Windows):

```sh
npm install -g https://github.com/keoshi/kerf/releases/latest/download/kerf-helper.tgz
```

## Level 1: probe (read-only, 2 minutes)

```sh
kerf probe
```

This connects over Bluetooth and asks for the firmware version, the installed tools and the status, then disconnects.
**It never moves the cutter.** The first run asks macOS for Bluetooth permission for your terminal app.

Open an issue with the **Cutter report** template and paste the JSON it prints, for example:

```json
{
  "name": "CAMEO 4-700181A",
  "firmware": "CAMEO 4 V1.20",
  "tools": "2, 0",
  "state": "ready",
  "model": { "id": "cameo4", "name": "CAMEO 4", "verified": true },
  "helper": "0.1.0",
  "os": "darwin arm64"
}
```

The `name` ends in a serial-number fragment. Remove it if you prefer; the part before the dash is what matters.

If the probe can't find your cutter, include the error and the cutter's Bluetooth name as shown in Silhouette Studio
or in a Bluetooth scanner app.

## Level 2: test cut (moves the cutter, 10 minutes)

Use **scrap paper on a mat** and conservative settings. A pen in the tool holder is even better, if you have one.

1. Install the Figma plugin (see [Install](README.md#2-the-figma-plugin) in the README).
2. Start the helper: run `kerf`, or open the **Kerf for Silhouette** app on macOS.
3. In the plugin, click **New mat**. It uses your model's mat size once the cutter is connected.
4. Draw a **20 × 20 mm square** 10 mm from the top and left, and a **circle** somewhere else.
5. Select the frame, pick a material (e.g. *Print Paper*), and click **Cut**.

In the report, tell us:

- Did it cut at all? Was the position right (10 mm from the top-left corner of the mat's cutting area)?
- Is the square 20.0 × 20.0 mm? (Measure with a ruler; this checks the 20 units-per-mm scale.)
- Did the blade depth / force behave as expected, or was it too deep or too shallow?
- Anything odd: unexpected head movements, errors in the helper log, a different mat size.

To test the **cutting width**, also place a small square near the right edge of the model's width,
e.g. at 370 mm on a 15" machine.

## Level 3: capture what Silhouette Studio sends (macOS, 20 minutes)

This tells us exactly which commands your model expects, so we can match them.
It records only the Bluetooth traffic between Silhouette Studio and the cutter.

1. Install Apple's **Bluetooth logging profile for macOS** from
   [developer.apple.com/bug-reporting/profiles-and-logs](https://developer.apple.com/bug-reporting/profiles-and-logs/)
   (search for "Bluetooth"; pick the **macOS** one). Install it in System Settings → General → Device Management,
   then restart.
2. Open Silhouette Studio and connect to the cutter over Bluetooth.
3. In a terminal, start recording (the full path matters: zsh has its own `log` command):

   ```sh
   /usr/bin/log stream --info --debug --predicate 'process == "ss_bluetooth"' > studio-capture.log
   ```

4. In Studio, cut a **20 × 20 mm square** on scrap paper. Note the material, blade, force, speed and depth you used.
5. Stop the recording with Ctrl-C and decode it:

   ```sh
   python3 tools/parse_bt_log.py studio-capture.log > studio-capture.txt
   ```

6. Attach `studio-capture.txt` (not the raw log) to your cutter report, with the settings from step 4.
7. Remove the logging profile afterwards (System Settings → General → Device Management → select it → **−**).

The decoded file contains only the commands Studio sent and the cutter's replies.
Have a look before attaching it; it should look like [`captures/studio-square-cut.txt`](captures/studio-square-cut.txt).

## Adding or fixing a model

Models live in [`packages/core/src/models.ts`](packages/core/src/models.ts). A model is identified by the firmware reply
(`FG`), e.g. `CAMEO 4 PLUS V1.20` → `CAMEO 4 PLUS`, falling back to the Bluetooth name. When a model is confirmed:

1. Fix its sizes if needed and set `verified: true`.
2. Add a test in `packages/core/test/core.test.ts` if identification needed a change.
3. Update the table at the top of this file.

If a model needs different setup commands, add that to `setupCommands` in
[`packages/core/src/gpgl.ts`](packages/core/src/gpgl.ts) keyed on the model, and keep the Cameo 4 output unchanged.
The Cameo 4 test in `core.test.ts` must keep passing byte for byte.

## Code

Setup, building and releasing are covered in [DEVELOPMENT.md](DEVELOPMENT.md).

```sh
git clone https://github.com/keoshi/kerf.git && cd kerf
npm install && npm run build
npm test            # core unit tests
npm run typecheck
```

- `packages/core` has no dependencies and must keep running in browsers (for the Web Bluetooth version).
- Physical cuts are always started by a person clicking **Cut**; tools and tests must never send jobs on their own.
- Reverse-engineering notes go in [`docs/silhouette-studio-findings.md`](docs/silhouette-studio-findings.md).
  We don't decrypt or redistribute Silhouette's files, and we don't modify Silhouette Studio.
