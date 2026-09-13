"""Generate the ComfyUI Registry icon (400x400 square PNG).

Registry requires: SVG/PNG/JPG/GIF, <=400x400, square.
Drawn from the panel's own palette so the listing matches the node UI:
    surface #17191b / border #34383c / accent #d0c9bb / gold #c6a76a
Motif = a stack of prompt cards (what TK Prompt Cards / the toolkit is about).

Reproducible: python tools/make_icon.py
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "screenshots", "icon.png")

SIZE = 400
SS = 4  # supersample factor: draw big, downscale -> clean anti-aliasing

BG = (23, 25, 27, 255)        # #17191b
BORDER = (52, 56, 60, 255)    # #34383c
ACCENT = (208, 201, 187, 255)  # #d0c9bb
GOLD = (198, 167, 106, 255)   # #c6a76a
CARD_BACK = (86, 83, 77, 255)
CARD_MID = (141, 136, 121, 255)
INK = (23, 25, 27, 255)


def rrect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def main() -> int:
    n = SIZE * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # tile
    rrect(d, (0, 0, n - 1, n - 1), int(n * 0.22), BG)
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * 0.22),
                        outline=BORDER, width=max(2, int(n * 0.006)))

    # three stacked prompt cards (back -> front)
    cw, ch, rad = int(n * 0.375), int(n * 0.465), int(n * 0.045)
    step = int(n * 0.075)
    base_x, base_y = int(n * 0.215), int(n * 0.335)
    for i, colour in enumerate((CARD_BACK, CARD_MID, ACCENT)):
        x = base_x + (2 - i) * step
        y = base_y - (2 - i) * step
        rrect(d, (x, y, x + cw, y + ch), rad, colour)

    # "prompt lines" on the front card
    fx, fy = base_x, base_y
    line_x0 = fx + int(cw * 0.15)
    for j, frac in enumerate((0.66, 0.5, 0.58)):
        ly = fy + int(ch * (0.24 + 0.17 * j))
        lh = max(3, int(n * 0.019))
        d.rounded_rectangle((line_x0, ly, line_x0 + int(cw * frac), ly + lh),
                            radius=lh // 2, fill=INK)

    # gold accent dot (top-right of the front card)
    dot_r = int(n * 0.032)
    cx, cy = fx + cw - int(cw * 0.16), fy + int(ch * 0.24) + dot_r // 2
    d.ellipse((cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r), fill=GOLD)

    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print("wrote %s (%d bytes, %dx%d)" % (OUT, os.path.getsize(OUT), SIZE, SIZE))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
