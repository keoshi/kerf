# Privacy policy

_Last updated: October 12, 2026_

Kerf (the Figma plugin "Kerf: Cut on Silhouette", the "Kerf for Silhouette" app and the `kerf` command) is built to
work entirely on your computer.

- **No data collection.** Kerf has no analytics, telemetry, accounts or tracking, and no servers of its own.
- **What the plugin reads.** Only the geometry of the layers you select, and only to preview and cut them.
- **Where it goes.** The plugin sends the cut job (shape outlines and cut settings) to the Kerf helper on your own
  computer at `http://localhost:47821`. The helper sends it to your Silhouette cutter over Bluetooth. Nothing is sent
  over the internet.
- **What's stored.** The plugin saves your preferences (material, units, blade) with Figma's `clientStorage` on your
  device. The helper app writes a local log to `~/Library/Logs/Kerf/helper.log`.
- **Bluetooth.** The helper connects only to Silhouette cutters, and only while the plugin is open or a job is running.

Kerf is open source, so you can verify all of this: https://github.com/keoshi/kerf

Questions: open an issue at https://github.com/keoshi/kerf/issues.
