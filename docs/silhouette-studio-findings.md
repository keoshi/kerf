# Silhouette Studio 5.0.414 — how it talks to the cutter

Investigated with REA (Ghidra 12.1.4) + string/bundle inspection on 2026-10-12.
Target: `/Applications/Silhouette Studio.app` (Xojo app, x86_64 main binary, 231 MB).

Legend: **[observed]** = seen in the shipped binary (REA evidence ID where available) ·
**[public]** = from open-source drivers (inkscape-silhouette / py_silhouette), not yet verified on our machine.

## Transports

### USB — raw IOKit bulk pipes [observed]
- Classes `usbmac_notifier`, `usbmac_device_ref`, `usbmac_interface`, `usbmac_pipe`,
  `usbmac_read_async`, `usbmac_write_async`.
- APIs: `IOServiceAddMatchingNotification` + `idVendor`/`idProduct` matching,
  `IOUSBDeviceInterface`, `IOUSBInterfaceInterface190`, `USBInterfaceOpen`, async pipe read/write.
- Not HID, not a serial port: a vendor-specific interface with one bulk OUT and one bulk IN pipe.
  So a helper can use libusb (`node-usb` / `pyusb`) with no driver install.
- The VID/PID table lives in encrypted resource data, not in the binary.
  **[public]** VID is `0x0B4D`; PIDs vary by model. Confirm with `ioreg -p IOUSB -l` once the Cameo is plugged in.

### Bluetooth LE — via the `ss_bluetooth.app` helper [observed]
`SPEC_CUTTER/bluetooth/ss_bluetooth.app/Contents/Frameworks/BluetoothIO.dylib` (CoreBluetooth).

| Role | UUID | Behaviour |
|---|---|---|
| Status characteristic | `61490654-B5B4-458c-A867-9E15BC1471E0` | notify enabled |
| Read (RX) characteristic | `8DCF199A-30E7-4bd4-BEB6-BEB57DCA866C` | notify enabled, payload decoded as UTF-8 → "data received" |
| Write (TX) characteristic | `6D92661D-F429-4d67-929B-28E7A9780912` | `writeValue:…type:0` (**with response**) |

- Evidence: `SSBLRF_OSX::initWithAddress:` (ev_c2926065…) builds the UUID array in that order.
  `didDiscoverCharacteristicsForService` (ev_649a1978…) assigns index 0 → Status, 1 → Read, 2 → Write.
  The order is inferred from the call sequence; Ghidra truncated the variadic `initWithObjects:` arguments.
- The scan has no service filter. A device is listed when it advertises a local name
  (`didDiscoverPeripheral`, ev_cebeb96e…).
- Send path (ev_1ca7bd87…, ev_d421b833…): the job is buffered and written in `send_limit`-byte chunks.
  The next chunk is sent only from `didWriteValueForCharacteristic`, i.e. one write in flight at a time.
  The `send_limit` value is set by the caller (`setSend_limit:`) and is not visible in the plugin.
  Use the negotiated MTU minus 3 as a starting point.
- The main app launches `ss_bluetooth` and talks to it over a local "memory socket" (`MSsocket_*`).

**Corroborated** by two independent open-source BLE drivers that use the same three UUIDs:
inkscape-silhouette `silhouette/BLETransport.py` (GPL-2.0) and bob-takuya/cameo-cut (MIT).
They add:
- vendor GATT service `e2088282-4fde-42f9-bb22-6ec3c7ed8f91`
- connect handshake:
  1. subscribe to Status and Read
  2. write `ESC 0x04` (`1b 04`, with response) to **each** of Status, Read and Write
  3. wait ~1 s, then discard any buffered input
- writes are 20-byte chunks with response; retry on the ATT "busy" error (back-pressure)
- Status notifies `"1\x03"` (moving) / `"0\x03"` (idle). Query replies arrive on Read only, so keep the two streams separate.
- on macOS the peripheral id is an opaque per-host UUID, so select the device by advertised name.

## Command language — Graphtec GPGL [observed]
- Driver classes: `Cutter_driver_gpgl`, `StudioToGPGL`, `GetGPGL_string`, `GPGL_Split`,
  `Accumulate_GPGL`, `SendToCutter_spec_gpgl_generate`, `ccom.write_packet` / `ccom.read_packet`.
- The command set is data-driven (`CutterCommandSpec{type,syntax,return_value_syntax,subset}`).
  It is loaded from encrypted `SPEC_CUTTER/language/lang`. `data` and `materials` (material presets) are also encrypted.
  We did not decrypt them, and don't need to.
- **[public]** GPGL basics, as used by inkscape-silhouette:
  - commands are ASCII, terminated by `\x03` (ETX)
  - `ESC 0x04` initialises; `ESC 0x05` polls status (`0` ready, `1` busy, `2` no media)
  - `FN0` orientation, `!n` speed, `FXn` force, `M x,y` move, `D x,y[,x,y…]` draw/cut
  - coordinates are 20 units per mm
  - Cameo 4+ add tool selection (`J1`/`J2`) and depth commands
  - Verify against a USB capture of Studio before relying on exact syntax.

### Cameo 4 job setup (from inkscape-silhouette `Graphtec.py`, [public])
- USB PIDs: Cameo 4 `0x1137`, 4 Plus `0x1138`, 4 Pro `0x1139` (VID `0x0B4D`). Coordinates are 20 units per mm.
- Per tool holder `n` (1 or 2):

  | Command | Meaning |
  |---|---|
  | `Jn` | select tool holder |
  | `!speed,n` | speed |
  | `FXforce,n` | force |
  | `TFdepth,n` | blade depth (AutoBlade) |
  | `FCoffset,n` | blade offset |
  | `FE0,n` / `FE1,n` | track enhancing off / on |
  | `TJaccel` | acceleration |

- Page and mat setup: `FN0`, `TB50,0|1` (portrait/landscape), `\y,x` / `Zy,x` (bounds).
  Registration marks use `TB99`, `TB52`, `TB51`, `TB53`, `TB55`, `TB123`.
- Tool IDs reported by the Cameo 4: 1 ratchet, 2 AutoBlade, 3 deep-cut, 4 Kraft, 5 rotary, 7 pen.

### GP-GL reference
Graphtec command table: https://www.ohthehugemanatee.net/uploads/2011/07/GP-GL.pdf

| Command | Meaning |
|---|---|
| `M` / `D` | absolute move / draw |
| `E` / `O` | relative draw / move |
| `BZ` | Bézier curve |
| `H` | home |
| `!` | speed |
| `J` | pen |
| `FC` | cutter offset |
| `V` / `@` / `#` | status words |
| `:` / `;` | clear |

Silhouette replaces `;` terminators with ETX (`0x03`).

## Live capture of Studio → Cameo 4 over BLE [observed, 2026-10-12]
- **Method:** with Apple's Bluetooth logging profile installed (macOS 27), CoreBluetooth logs each
  `CBMsgIdCharacteristicWriteValue`, payload included, to the unified log. PacketLogger itself captured nothing.
  ```
  /usr/bin/log stream --info --debug --predicate 'process == "ss_bluetooth"' > live.log
  python3 tools/parse_bt_log.py live.log
  ```
  - Payloads over 32 bytes are elided by macOS (first 16 + last 8 bytes kept).
  - Notifications from the cutter are not logged on this path.
  - Use `/usr/bin/log`, because zsh has a `log` builtin.
- **Advertised name:** `CAMEO 4-700181A`. Studio shows it as "CAMEO 4 (5ACD26DB)", the first block of the macOS peripheral UUID.
  The OS GATT dump confirms service `E2088282-4FDE-42F9-BB22-6EC3C7ED8F91`.
- **All job traffic** goes to one characteristic (value handle 29) as writes with response, at most about 39 bytes per write.
  Each write packs several ETX-terminated commands.
- **Connect handshake** (after Studio relaunch): `ESC 0x11`, then `FG`, `TI`, `TO`, `FG`, `TI`, `TB71`, `FA`, `TC`, `TI`.
  These are identity/firmware/tool queries.
- **Idle polling**, about every 0.3–0.5 s, in rotation: `ESC 0x05` (status), `ESC 0x15`, `ESC 0x16` (meaning unknown).
- **On material select:** `FC18,1,1` (blade offset 18 SU = 0.9 mm, holder 1) and `TF1,1` (AutoBlade depth 1).
- **Job for a 2 cm square** (Vinyl Matte: force 10, speed 5, depth 1, 1 pass):
  ```
  TG0 FN0 TB50,0 \…(12 elided)…2890 J1
  FX10,1 TJ3 !5,1 …(7)… 1 FE0,1
  FF1,1,1 FF1,1,1 …(3)… 0,1 TJ3
  FC18,1,1 TF1,1
  M1314,2817 BE1<binary> …(15)… BE1<binary>
  L0 \0,0 M0,0 J1 …(3)… TB50,0
  ```
  - Studio draws with **`BE1` + binary relative segments**, an undocumented compact form, rather than ASCII `D`.
  - We will use ASCII `M`/`D`, which inkscape-silhouette uses successfully on Cameo 4.
  - `BE` stays unknown; it isn't needed.
  - Coordinates in `M1314,2817` are in SU (20/mm) and appear to be in y,x order.

## Supported models — `SPEC_CUTTER/firmware` [observed, 2026-10-12]

Studio 5.0.414 bundles one firmware image per model family as plain Motorola S-record files
(`SPEC_CUTTER/firmware/<guid>/<version>/V<version>_R000n.S`). The images were only read for their identity strings;
nothing was decrypted or modified.

| GUID folder | Versions | S0 header | Model names in the image |
|---|---|---|---|
| `ebc72c8e…` | 1.20, 5.05 | `CAMEO4_Vxxx.bin` | CAMEO 4, CAMEO 4 PLUS, CAMEO 4 PRO |
| `0408d6c7…` | 1.07 | `CAMEO5_Vxxx.bin` | CAMEO 5, CAMEO 5 PLUS, CAMEO 5 PRO |
| `be6fc9df…` | 1.04 | `CAMEO5Alpha_Vxxx.bin` | CAMEO 5 ALPHA (`5A`), CAMEO 5 ALPHA PLUS (`5APL`) |
| `fa95768c…` | 1.10 | `CAMEOProMark2_Vxxx.bin` | CAMEO PRO MARK2 (`PRO2`) |
| `d8960ad9…` | 1.05, 5.02 | `Portrait3_Vxxx.bin` | Portrait 3 |
| `74f19aad…` | 1.05 | `Portrait4_Vxxx.bin` | Portrait 4 |
| `569c0ad0…` | 1.16 | `CURIO2_Vxxx.bin` | CURIO 2 |
| `71da6556…` | 1.02 | `ASF_Vxxx.bin` | (no model string; likely an accessory such as the AutoSheet Feeder) |

- One image serves a whole family, e.g. Cameo 4 / 4 Plus / 4 Pro. The firmware builds its name from a base plus a
  suffix (`"CAMEO 4"`, `" PLUS"`, `" PRO"`) and formats the version as `V%d.%02d`, so `FG` answers e.g.
  `CAMEO 4 PLUS V1.20`. We identify the model from that reply, falling back to the Bluetooth name
  (`CAMEO 4-700181A`). See `packages/core/src/models.ts`.
- The same images contain IEEE 1284 device IDs (`MANUFACTURER:Silhouette;MODEL:CAMEO 4 PLUS;…`) used over USB.
- `firmware_rules/<guid>/rules` are tiny (29–50 byte) big-endian records, probably minimum Studio/firmware versions for
  updates. They're not needed for cutting.
- The Cameo 4 image includes strings for a classic Bluetooth serial-port profile (`Serial Port Service`, `APO-SPPCONN`)
  alongside BLE; Studio uses BLE only.
- `test_cut/*` are Studio documents (`silhouette05;` header) for the built-in test cuts.
- Sizes (cutting width, mat) are not in readable form; `models.ts` uses the manufacturer's published nominal values,
  and only the Cameo 4 is verified. CONTRIBUTING.md explains how owners of other models can help.

## Cancelling a job [tested, 2026-10-12]

Studio's driver has `Cutter_driver.abort_job` (an empty base method) and `Cutter_driver_gpgl.*execute_interrupt`, which
queues commands from Studio's data-driven command set (`CutterCommandSet`); the actual bytes live in the encrypted `data`
file, so they weren't read. Kerf instead stops streaming and sends **`ESC EOT` (`1b 04`)**, the documented "initialise"
escape that Studio also sends when connecting. On a CAMEO 4 (firmware 1.20) mid-cut, this drops the buffered commands,
lifts the tool and returns the head home; the cutter then reports ready (`ESC ENQ` → `0`).

## Material presets
There is no official machine-readable chart. Studio's own presets are in the encrypted `materials` file.

Usable sources:
- **cameo-cut `resources/presets.json`** (MIT): 13 presets, about 10 materials plus score/draw.
  Fields: force, speed, depth, passes, tool. This is the safest base to copy.
- inkscape-silhouette `MEDIA` table (GPL): 25 older paper/film media.
  Values come from robocut and older machines, with no depth.
- Retailer and blog charts: inconsistent with each other; starting points only.

Plan: seed from cameo-cut, then correct using Studio's own values for the materials actually used.

Studio reference point (user's Cameo 4, firmware 1.20, Bluetooth name shown as "CAMEO 4 (5ACD26DB)"):
- **Vinyl, Matte**: Cut action, AutoBlade, force 10, speed 5, passes 1, depth 1.
- This is identical to cameo-cut's `vinyl` preset (10/5/1/1), so its scales match Studio's.

## Implications for a Figma workflow
1. Figma plugins can't reach USB or Bluetooth (sandboxed iframe), so a **local helper is required**.
   The plugin UI talks to it on `http://localhost:<port>`, allowed through `networkAccess` in `manifest.json`.
2. Plugin: take selected vectors (`fillGeometry` / `strokeGeometry` + `absoluteTransform`,
   or `exportAsync({format:'SVG_STRING'})`), flatten curves to polylines, convert units to mm, POST as JSON.
3. Helper: JSON → GPGL → USB bulk OUT (libusb), poll status on bulk IN.
   Optionally BLE using the UUIDs above, with write-with-response and sequential chunking.
4. Material settings (speed/force/depth/blade) must be entered by us.
   Read them once from Studio's UI for the materials you use.
