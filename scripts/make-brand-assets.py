#!/usr/bin/env python3
"""Regenerate the app's brand images from one source picture.

This is a maintenance tool. It is not part of `npm run build`, the tests or CI,
and it is the only thing in this repository that needs Pillow:

    python -m pip install pillow
    python scripts/make-brand-assets.py            # uses branding/shelricktech-logo.jpg
    python scripts/make-brand-assets.py other.png  # or any other square picture

It writes

    public/icons/favicon-32.png          32x32    rounded tile  (browser tab)
    public/icons/icon-192.png            192x192  rounded tile  (installed app)
    public/icons/icon-512.png            512x512  rounded tile  (installed app, splash screen)
    public/icons/icon-maskable-512.png   512x512  full bleed    (Android adaptive icon)
    public/icons/apple-touch-icon.png    180x180  full bleed    (iOS home screen)

and replaces the built-in logo in src/main.js (BRAND_DEFAULT.logo, a small JPEG
data URI shown in the sidebar and on the login screen).

Afterwards run `npm run build` and commit the changed files, including dist/.

The picture is expected to sit on a white (or near-white) background. The
rounded tiles keep that background, because a logo with dark lettering would
disappear on the app's dark surfaces if the background were made transparent.
"""
import base64
import io
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "branding" / "shelricktech-logo.jpg"
ICONS = ROOT / "public" / "icons"
MAIN_JS = ROOT / "src" / "main.js"

WHITE = (255, 255, 255)
# Rounded tiles: corner radius as a fraction of the icon width.
CORNER_RADIUS = 0.18
# Maskable icons may be cropped to a circle whose diameter is 80% of the icon.
# The artwork is scaled so that all of it stays inside that circle, with a
# little room to spare.
MASKABLE_SAFE_DIAMETER = 0.80
MASKABLE_SPARE = 0.97
# The logo built into the page: shown at 26 px (sidebar) and 76 px (login).
EMBED_SIZE = 220
EMBED_QUALITY = 86

LOGO_LITERAL = re.compile(r"(const BRAND_DEFAULT=\{name:'[^']*',tag:'[^']*',logo:')data:image/jpeg;base64,[A-Za-z0-9+/=]+(')")


def load_square_on_white(path):
    """The source as an RGB square on pure white."""
    image = Image.open(path)
    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        flat = Image.new("RGB", rgba.size, WHITE)
        flat.paste(rgba, mask=rgba.getchannel("A"))
        image = flat
    else:
        image = image.convert("RGB")
    if image.width != image.height:
        side = max(image.size)
        square = Image.new("RGB", (side, side), WHITE)
        square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        image = square
    # Compressed pictures carry an off-white background (251-255). Make it pure
    # white so the artwork's edge never shows against the white canvas.
    red, green, blue = image.split()
    darkest = ImageChops.darker(ImageChops.darker(red, green), blue)
    background = darkest.point(lambda value: 255 if value >= 248 else 0)
    return Image.composite(Image.new("RGB", image.size, WHITE), image, background)


def artwork_radius(image):
    """Distance of the farthest visible mark from the centre, as a fraction of half the width."""
    side = 400
    small = image.resize((side, side), Image.BOX)
    pixels = small.load()
    centre = (side - 1) / 2
    farthest = 0.0
    for y in range(side):
        for x in range(side):
            if min(pixels[x, y]) < 235:
                farthest = max(farthest, math.hypot(x - centre, y - centre))
    return farthest / (side / 2)


def scaled(image, size):
    return image.resize((size, size), Image.LANCZOS)


def rounded_tile(image, size):
    tile = scaled(image, size).convert("RGBA")
    oversample = 8
    mask = Image.new("L", (size * oversample, size * oversample), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * oversample - 1, size * oversample - 1),
        radius=round(size * oversample * CORNER_RADIUS),
        fill=255,
    )
    # Area averaging gives the exact coverage of each pixel; a sharpening filter
    # would leave a faint haze in the transparent corners.
    tile.putalpha(mask.resize((size, size), Image.BOX))
    return tile


def maskable(image, size, scale):
    canvas = Image.new("RGB", (size, size), WHITE)
    inner = round(size * scale)
    offset = (size - inner) // 2
    canvas.paste(scaled(image, inner), (offset, offset))
    return canvas


def embedded_logo(image):
    buffer = io.BytesIO()
    scaled(image, EMBED_SIZE).save(buffer, "JPEG", quality=EMBED_QUALITY, subsampling=0, optimize=True)
    return buffer.getvalue()


def write_png(image, name):
    target = ICONS / name
    image.save(target, "PNG", optimize=True)
    print(f"  {target.relative_to(ROOT)}  {image.width}x{image.height}  {target.stat().st_size} bytes")


def main(argv):
    source = Path(argv[1]).resolve() if len(argv) > 1 else DEFAULT_SOURCE
    if not source.is_file():
        print(f"Source picture not found: {source}", file=sys.stderr)
        return 1
    image = load_square_on_white(source)
    if image.width < 512:
        print(f"Source picture is {image.width} px wide; at least 512 px is needed for a sharp icon.", file=sys.stderr)
        return 1

    radius = artwork_radius(image)
    maskable_scale = min(1.0, MASKABLE_SAFE_DIAMETER * MASKABLE_SPARE / radius) if radius > 0 else 1.0
    print(f"Source: {source}  ({image.width}x{image.height})")
    print(f"Artwork reaches {radius:.1%} of the half-width; maskable icon drawn at {maskable_scale:.1%}")

    # newline="" keeps the file's line endings exactly as they are, on every platform.
    with open(MAIN_JS, encoding="utf-8", newline="") as handle:
        main_js = handle.read()
    if len(LOGO_LITERAL.findall(main_js)) != 1:
        print("Could not find exactly one BRAND_DEFAULT logo in src/main.js; nothing was written.", file=sys.stderr)
        return 1

    ICONS.mkdir(parents=True, exist_ok=True)
    write_png(rounded_tile(image, 32), "favicon-32.png")
    write_png(rounded_tile(image, 192), "icon-192.png")
    write_png(rounded_tile(image, 512), "icon-512.png")
    write_png(maskable(image, 512, maskable_scale), "icon-maskable-512.png")
    write_png(scaled(image, 180), "apple-touch-icon.png")

    jpeg = embedded_logo(image)
    data_uri = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
    with open(MAIN_JS, "w", encoding="utf-8", newline="") as handle:
        handle.write(LOGO_LITERAL.sub(lambda match: match.group(1) + data_uri + match.group(2), main_js))
    print(f"  src/main.js  BRAND_DEFAULT.logo  {EMBED_SIZE}x{EMBED_SIZE} JPEG  {len(jpeg)} bytes ({len(data_uri)} characters)")
    print("Now run: npm run build   (and commit the changed files, including dist/)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
