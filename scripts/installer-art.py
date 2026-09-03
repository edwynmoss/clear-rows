"""Generate the NSIS installer artwork from the Clear Rows mark.

    python scripts/installer-art.py

Writes 24-bit BMPs into src-tauri/installer/ (NSIS wants BMP):
  header.bmp   150 x 57   top-right of the inner pages
  sidebar.bmp  164 x 314  left panel of the welcome and finish pages
  splash.bmp   420 x 260  fading splash shown while the installer starts
Also writes src-tauri/icons/source.png (1024 px app-icon source: the mark on
a dark rounded tile so it reads on light and dark taskbars) and
public/app-icon.png (the same tile, used as the web favicon). Regenerate the
platform icon set afterwards with `npx tauri icon src-tauri/icons/source.png`.

The mark is drawn from geometry (the same paths as the in-app SVG), so the
artwork stays crisp at any size and needs no external image.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "installer"

INK = (23, 23, 22)          # bars on light
PAPER = (255, 255, 255)
NIGHT = (17, 18, 20)        # dark panel
NIGHT_INK = (236, 236, 233) # bars on dark
GOLD = (212, 184, 74)
MUTED = (140, 142, 148)


def mark(draw: ImageDraw.ImageDraw, x: float, y: float, w: float, ink, gold, scale=4) -> None:
    """Draw the mark with its left edge at (x, y) and width w.

    Geometry is the 1024px artwork's 665 x 400 content box, scaled.
    """
    s = w / 665.0
    def p(pts):
        return [(x + (px - 180) * s, y + (py - 312) * s) for px, py in pts]
    bars = [
        [(180, 312), (470, 312), (503, 384), (180, 384)],
        [(555, 312), (845, 312), (845, 384), (522, 384)],
        [(180, 476), (388, 476), (358, 548), (180, 548)],
        [(628, 476), (845, 476), (845, 548), (598, 548)],
        [(180, 640), (470, 640), (503, 712), (180, 712)],
        [(555, 640), (845, 640), (845, 712), (522, 712)],
    ]
    for poly in bars:
        draw.polygon(p(poly), fill=ink)
    draw.polygon(p([(412, 476), (604, 476), (573, 548), (382, 548)]), fill=gold)


def supersampled(size, paint, scale=4) -> Image.Image:
    big = Image.new("RGB", (size[0] * scale, size[1] * scale))
    draw = ImageDraw.Draw(big)
    paint(draw, scale)
    return big.resize(size, Image.LANCZOS)


def font(size: int, weight: str = "Regular") -> ImageFont.FreeTypeFont:
    candidates = [
        f"C:/Windows/Fonts/segoeui{'sb' if weight == 'Semibold' else 'b' if weight == 'Bold' else ''}.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def header() -> Image.Image:
    def paint(d, k):
        # The MUI header background is the same dark as this strip.
        d.rectangle([0, 0, 150 * k, 57 * k], fill=NIGHT)
        mark(d, 96 * k, 17 * k, 40 * k, NIGHT_INK, GOLD)
    return supersampled((150, 57), paint)


def sidebar() -> Image.Image:
    def paint(d, k):
        d.rectangle([0, 0, 164 * k, 314 * k], fill=NIGHT)
        mark(d, 30 * k, 96 * k, 104 * k, NIGHT_INK, GOLD)
        # Thin gold rule under the mark, echoing the selected row.
        d.rectangle([30 * k, 178 * k, 134 * k, 179 * k], fill=(48, 46, 38))
    img = supersampled((164, 314), paint)
    d = ImageDraw.Draw(img)
    d.text((30, 196), "Clear Rows", font=font(17, "Semibold"), fill=NIGHT_INK)
    d.text((30, 222), "Large CSV files,", font=font(11), fill=MUTED)
    d.text((30, 238), "opened instantly.", font=font(11), fill=MUTED)
    return img


def splash() -> Image.Image:
    def paint(d, k):
        d.rectangle([0, 0, 420 * k, 260 * k], fill=NIGHT)
        mark(d, 130 * k, 72 * k, 160 * k, NIGHT_INK, GOLD)
    img = supersampled((420, 260), paint)
    d = ImageDraw.Draw(img)
    f = font(20, "Semibold")
    text = "Clear Rows"
    w = d.textlength(text, font=f)
    d.text(((420 - w) / 2, 196), text, font=f, fill=NIGHT_INK)
    return img


def icon_tile(size: int) -> Image.Image:
    """The mark on a dark rounded tile, filling the canvas like a modern app icon."""
    k = 4
    big = Image.new("RGBA", (size * k, size * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    inset = int(size * k * 0.04)
    radius = int(size * k * 0.21)
    d.rounded_rectangle([inset, inset, size * k - inset, size * k - inset], radius=radius, fill=NIGHT)
    # Mark width 72% of the canvas; its 665x400 box is centred optically a
    # touch above the middle.
    w = size * k * 0.72
    h = w * 400 / 665
    x = (size * k - w) / 2
    y = (size * k - h) / 2
    mark(d, x, y, w, NIGHT_INK, GOLD)
    return big.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon_tile(1024).save(ROOT / "src-tauri" / "icons" / "source.png")
    icon_tile(256).save(ROOT / "public" / "app-icon.png")
    print("wrote icon sources")
    for name, image in (("header.bmp", header()), ("sidebar.bmp", sidebar()), ("splash.bmp", splash())):
        image.convert("RGB").save(OUT / name, format="BMP")
        print(f"wrote {OUT / name} ({image.size[0]}x{image.size[1]})")


if __name__ == "__main__":
    main()
