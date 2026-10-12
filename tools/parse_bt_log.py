"""Rebuild CoreBluetooth GATT traffic from `log show` output.

Usage:
  /usr/bin/log show --last 3h --info --debug \
    --predicate 'process == "bluetoothd" OR subsystem BEGINSWITH "com.apple.bluetooth"' > bt.log
  python3 tools/parse_bt_log.py bt.log [--process ss_bluetooth] [--device <uuid>]

Prints one line per write / notification with the characteristic handle and payload,
plus a decoded ASCII view (ETX shown as '⏎', ESC as '␛').
"""
import argparse
import re

HEADER = re.compile(r"^(\S+ \S+)\s+\S+\s+\S+\s+\S+\s+\d+\s+\d+\s+(\S+?):.*Sending XPC message (CBMsgId\w+): \{$|"
                    r"^(\S+ \S+)\s+\S+\s+\S+\s+\S+\s+\d+\s+\d+\s+(\S+?):.*Received XPC message (CBMsgId\w+): \{$")
FIELD = re.compile(r"^\s+(kCBMsgArg\w+) = (.*);$")
# macOS elides payloads over 32 bytes: "{length = 39, bytes = 0x<16 bytes> ... <8 bytes> }".
DATA = re.compile(r"\{length = (\d+), bytes = 0x([0-9a-f ]+?)(?: \.\.\. ([0-9a-f ]+?))?\s*\}")


def decode(b):
    out = []
    for c in b:
        if c == 0x03:
            out.append("⏎")
        elif c == 0x1B:
            out.append("␛")
        elif 32 <= c < 127:
            out.append(chr(c))
        else:
            out.append("\\x%02x" % c)
    return "".join(out)


def blocks(path):
    with open(path, errors="replace") as fh:
        lines = iter(fh)
        for line in lines:
            m = HEADER.match(line.rstrip("\n"))
            if not m:
                continue
            ts, proc, msg = (m.group(1), m.group(2), m.group(3)) if m.group(1) else (m.group(4), m.group(5), m.group(6))
            fields = {}
            for body in lines:
                if body.startswith("}"):
                    break
                f = FIELD.match(body.rstrip("\n"))
                if f:
                    fields[f.group(1)] = f.group(2)
            yield ts, proc, msg, fields


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("--process", default="ss_bluetooth")
    ap.add_argument("--device")
    ap.add_argument("--stream", action="store_true", help="print concatenated write stream per handle")
    a = ap.parse_args()
    streams = {}
    for ts, proc, msg, f in blocks(a.log):
        if proc != a.process or "kCBMsgArgData" not in f:
            continue
        if a.device and a.device.lower() not in f.get("kCBMsgArgDeviceUUID", "").lower():
            continue
        d = DATA.search(f["kCBMsgArgData"])
        if not d:
            continue
        length = int(d.group(1))
        head = bytes.fromhex(d.group(2).replace(" ", ""))
        tail = bytes.fromhex(d.group(3).replace(" ", "")) if d.group(3) else b""
        truncated = bool(tail) or len(head) != length
        raw = head + tail
        handle = f.get("kCBMsgArgCharacteristicValueHandle") or f.get("kCBMsgArgCharacteristicHandle")
        kind = "W" if "Write" in msg else "N"
        if a.stream:
            streams.setdefault((kind, handle), bytearray()).extend(raw)
        else:
            shown = f"{decode(head)} …[{length - len(head) - len(tail)} bytes elided]… {decode(tail)}" if truncated else decode(raw)
            print(f"{ts[11:23]} {kind} h={handle:>3} len={length:<3} {shown}")
    for (kind, handle), data in streams.items():
        print(f"== {kind} handle {handle} ({len(data)} bytes)\n{decode(data)}\n")


if __name__ == "__main__":
    main()
