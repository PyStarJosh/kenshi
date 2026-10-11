"""Draw the Home Screen icons: a bold yellow "K" on black, high contrast, drawn from lines so no font is needed.

  uv run --group ml python ml/make_icons.py

Writes web/public/icons/icon-512.png, icon-192.png, and apple-touch-icon.png (180 px). The icons are opaque squares
(iOS rounds the corners itself and fills any transparency with black), and the letter stays inside the middle 60% so
no mask cuts it off. Run it again after changing the colors below.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

BACKGROUND = (0, 0, 0)  # matches the app's black background and the manifest colors
FOREGROUND = (255, 214, 10)  # yellow on black is about 14:1 contrast
SUPERSAMPLE = 4  # draw large, then shrink, so the edges are smooth
OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "public" / "icons"
SIZES = {"icon-512.png": 512, "icon-192.png": 192, "apple-touch-icon.png": 180}

# The letter in unit coordinates (0 to 1 across the square): a stem and two arms meeting at the middle of the stem.
STEM_X = 0.34
TOP_Y, MID_Y, BOTTOM_Y = 0.22, 0.50, 0.78
ARM_X = 0.68
STROKE = 0.11


def draw_icon(size: int) -> Image.Image:
    big = size * SUPERSAMPLE
    image = Image.new("RGB", (big, big), BACKGROUND)
    draw = ImageDraw.Draw(image)
    width = round(STROKE * big)

    def point(x: float, y: float) -> tuple[float, float]:
        return x * big, y * big

    def stroke(a: tuple[float, float], b: tuple[float, float]) -> None:
        draw.line([point(*a), point(*b)], fill=FOREGROUND, width=width)
        for x, y in (a, b):  # round caps
            cx, cy = point(x, y)
            r = width / 2
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FOREGROUND)

    stroke((STEM_X, TOP_Y), (STEM_X, BOTTOM_Y))
    stroke((STEM_X, MID_Y), (ARM_X, TOP_Y))
    stroke((STEM_X, MID_Y), (ARM_X, BOTTOM_Y))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in SIZES.items():
        draw_icon(size).save(OUT_DIR / name, optimize=True)
        print(f"wrote {OUT_DIR / name} ({size}x{size})")


if __name__ == "__main__":
    main()
