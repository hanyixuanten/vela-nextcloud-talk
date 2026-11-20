#!/usr/bin/env python3
"""Generate the page background glow used by the watch UI.

The look follows the HyperBilibili watch template: a black page with two soft
coloured glows (pink + blue). It has to be a bitmap because Vela CSS has no
gradients, so the image is written straight to PNG here instead of being
exported from a design tool — pixel data only, no vectors.

    python3 scripts/gen-bg.py

Outputs (256x256; the layout draws it in a 480x480 box with `object-fit:
cover`, so the bitmap is upscaled by the page, not by the PNG itself):
    src/common/images/bg/pink.png
    src/common/images/bg/blue.png
"""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "common" / "images" / "bg"

SIZE = 256
BASE = (8, 8, 10)

# (colour, centre x, centre y, radius as a fraction of the image, strength)
VARIANTS = {
    "pink": [
        ((255, 125, 168), 0.20, 0.12, 0.95, 1.05),
        ((13, 122, 255), 0.88, 0.96, 0.72, 0.45),
    ],
    "blue": [
        ((13, 122, 255), 0.18, 0.10, 0.92, 0.95),
        ((255, 125, 168), 0.90, 0.94, 0.70, 0.40),
    ],
}


def glow(x, y, colour, cx, cy, radius, strength):
    dx = x - cx
    dy = y - cy
    distance = math.sqrt(dx * dx + dy * dy) / radius
    if distance >= 1.0:
        return (0.0, 0.0, 0.0)
    # Smooth falloff: bright in the middle, no visible edge at the rim.
    weight = (1.0 - distance) ** 2 * strength
    return tuple(channel * weight for channel in colour)


def render(layers):
    rows = []
    for y in range(SIZE):
        row = bytearray([0])  # PNG filter type 0 for every scanline
        py = (y + 0.5) / SIZE
        for x in range(SIZE):
            px = (x + 0.5) / SIZE
            r, g, b = BASE
            for layer in layers:
                dr, dg, db = glow(px, py, *layer)
                r += dr
                g += dg
                b += db
            row.extend((min(255, int(r)), min(255, int(g)), min(255, int(b)), 255))
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(kind, payload):
    body = kind + payload
    return (
        struct.pack(">I", len(payload))
        + body
        + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    )


def write_png(path, raw):
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return len(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, layers in VARIANTS.items():
        target = OUT / (name + ".png")
        size = write_png(target, render(layers))
        print("wrote %s (%d bytes)" % (target.relative_to(ROOT), size))


if __name__ == "__main__":
    main()
