#!/usr/bin/env python3
"""Generate the 192x192 app icon without any third-party imaging library.

Vela requires a plain PNG at /common/images/icon.png (192x192 is enough).
Pillow is often unavailable in build containers, so this script writes the
PNG itself: zlib for the IDAT stream and struct for the chunk headers.

Run from the project root:
    python3 scripts/gen-icon.py
"""

import struct
import zlib

SIZE = 192
SS = 4  # supersampling factor, 4x4 samples per output pixel


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # Shrink to the inner rectangle, then test the corner radius.
    ix0, iy0, ix1, iy1 = x0 + r, y0 + r, x1 - r, y1 - r
    if ix0 <= x <= ix1 or iy0 <= y <= iy1:
        return True
    cx = ix0 if x < ix0 else ix1
    cy = iy0 if y < iy0 else iy1
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, p0, p1, p2):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

    d1 = sign((x, y), p0, p1)
    d2 = sign((x, y), p1, p2)
    d3 = sign((x, y), p2, p0)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


# --- palette -------------------------------------------------------------
BG_TOP = (0x18, 0xAA, 0xEC)
BG_BOTTOM = (0x00, 0x53, 0x8A)
BUBBLE = (0xFF, 0xFF, 0xFF)
DOT = (0x00, 0x6D, 0xA8)

CX = CY = SIZE / 2
RADIUS = SIZE / 2 - 2

# Bubble geometry (in output pixel space, 192x192)
BX0, BY0, BX1, BY1, BR = 40, 48, 152, 120, 22
TAIL = ((62, 116), (74, 142), (92, 116))
DOT_Y = 84
DOT_R = 8
DOT_X = (68, 96, 124)


def sample(x, y):
    """Return (r, g, b, a) for one sub-pixel sample."""
    if not in_circle(x, y, CX, CY, RADIUS):
        return (0, 0, 0, 0)

    # Vertical gradient across the badge.
    t = max(0.0, min(1.0, (y - (CY - RADIUS)) / (2 * RADIUS)))
    color = mix(BG_TOP, BG_BOTTOM, t)

    inside_bubble = in_round_rect(x, y, BX0, BY0, BX1, BY1, BR) or in_triangle(
        x, y, *TAIL
    )
    if inside_bubble:
        color = BUBBLE
        for dx in DOT_X:
            if in_circle(x, y, dx, DOT_Y, DOT_R):
                color = DOT
                break

    return (color[0], color[1], color[2], 255)


def render():
    rows = []
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    sr, sg, sb, sa = sample(x, y)
                    # Premultiply so transparent samples do not darken edges.
                    w = sa / 255.0
                    r += sr * w
                    g += sg * w
                    b += sb * w
                    a += sa
            n = SS * SS
            alpha = a / n
            if alpha <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                weight = a / 255.0
                row += bytes(
                    (
                        int(round(r / weight)),
                        int(round(g / weight)),
                        int(round(b / weight)),
                        int(round(alpha)),
                    )
                )
        rows.append(bytes(row))
    return rows


def chunk(kind, payload):
    body = kind + payload
    return (
        struct.pack(">I", len(payload))
        + body
        + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    )


def write_png(path, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(data)


if __name__ == "__main__":
    write_png("src/common/images/icon.png", render())
    print("wrote src/common/images/icon.png (%dx%d)" % (SIZE, SIZE))
