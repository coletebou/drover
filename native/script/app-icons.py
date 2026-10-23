#!/usr/bin/env python3
"""Write every Drover app icon set from one 1024px master.

    python3 script/app-icons.py            # draw the placeholder master, then write all sets
    python3 script/app-icons.py MASTER.png # use real artwork instead (1024x1024, opaque)

The real artwork is docs/brand/mark.svg; docs/brand/render.sh renders it and calls this script.

The generated PNGs and Contents.json files are committed: CI has no Pillow, and the icon sets
change only when the artwork does. Rules (App Store validation):
  - iOS uses a classic explicit-size set (the validator wants 120x120 and 152x152 files), opaque.
  - watchOS gets its own single-size 1024 set in its own catalog, opaque. Never share one set
    between iOS and watchOS: export then reports "No icons found for watch application".
  - macOS uses the explicit 16...512 @1x/@2x set, with the usual transparent margin.
Needs Pillow (pip install pillow).
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
INFO = {"author": "xcode", "version": 1}

# (catalog, kind). Each catalog gets AppIcon.appiconset; the target sets ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon.
CATALOGS = [
    ("Apps/iOS/Resources/Assets.xcassets", "ios"),
    ("Apps/watchOS/Resources/Assets.xcassets", "watchos"),
    ("Apps/macOS/Assets.xcassets", "macos"),
    ("Apps/MenuBar/Assets.xcassets", "macos"),
]

# (idiom, size in points, scale)
IOS = [
    ("iphone", 20, 2), ("iphone", 20, 3), ("iphone", 29, 2), ("iphone", 29, 3),
    ("iphone", 40, 2), ("iphone", 40, 3), ("iphone", 60, 2), ("iphone", 60, 3),
    ("ipad", 20, 1), ("ipad", 20, 2), ("ipad", 29, 1), ("ipad", 29, 2),
    ("ipad", 40, 1), ("ipad", 40, 2), ("ipad", 76, 1), ("ipad", 76, 2), ("ipad", 83.5, 2),
    ("ios-marketing", 1024, 1),
]
MACOS = [("mac", s, k) for s in (16, 32, 128, 256, 512) for k in (1, 2)]


def placeholder() -> Image.Image:
    """Indigo-to-teal field with a white 'D': clearly a placeholder, valid everywhere."""
    n = 1024
    top, bottom = (49, 46, 129), (13, 148, 136)
    column = Image.new("RGB", (1, n))
    for y in range(n):
        t = y / (n - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    img = column.resize((n, n), Image.Resampling.NEAREST)
    d = ImageDraw.Draw(img)
    w = 92  # stroke width of the D
    left, right, y0, y1 = 300, 744, 232, 792
    r = (y1 - y0) // 2
    d.rectangle([left, y0, left + w, y1], fill="white")
    d.rectangle([left, y0, right - r, y0 + w], fill="white")
    d.rectangle([left, y1 - w, right - r, y1], fill="white")
    d.arc([right - 2 * r, y0, right, y1], start=270, end=90, fill="white", width=w)
    return img


def size_label(pt: float) -> str:
    return f"{pt:g}x{pt:g}"


def file_name(pt: float, scale: int) -> str:
    return f"icon-{pt:g}@{scale}x.png"


def write_png(img: Image.Image, px: int, path: Path) -> None:
    img.resize((px, px), Image.Resampling.LANCZOS).save(path, optimize=True)


def mac_master(master: Image.Image) -> Image.Image:
    """macOS icons sit on a transparent canvas with a rounded-square body (824 of 1024, Apple's grid)."""
    n, body, radius = 1024, 824, 185
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    mask = Image.new("L", (body, body), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, body - 1, body - 1], radius=radius, fill=255)
    off = (n - body) // 2
    canvas.paste(master.resize((body, body), Image.Resampling.LANCZOS).convert("RGBA"), (off, off), mask)
    return canvas


def write_set(catalog: Path, kind: str, master: Image.Image) -> None:
    catalog.mkdir(parents=True, exist_ok=True)
    root_contents = catalog / "Contents.json"
    if not root_contents.exists():
        root_contents.write_text(json.dumps({"info": INFO}, indent=2) + "\n")
    iconset = catalog / "AppIcon.appiconset"
    iconset.mkdir(exist_ok=True)
    for old in iconset.glob("*.png"):
        old.unlink()
    images = []
    if kind == "watchos":
        write_png(master, 1024, iconset / "icon-1024.png")
        images.append({"filename": "icon-1024.png", "idiom": "universal", "platform": "watchos", "size": "1024x1024"})
    else:
        art = mac_master(master) if kind == "macos" else master
        written = set()
        for idiom, pt, scale in (MACOS if kind == "macos" else IOS):
            name = file_name(pt, scale)
            if name not in written:
                write_png(art, round(pt * scale), iconset / name)
                written.add(name)
            images.append({"filename": name, "idiom": idiom, "scale": f"{scale}x", "size": size_label(pt)})
    (iconset / "Contents.json").write_text(json.dumps({"images": images, "info": INFO}, indent=2) + "\n")
    print(f"app-icons: {iconset.relative_to(ROOT)} ({len(images)} slots)")


def main() -> None:
    if len(sys.argv) > 1:
        master = Image.open(sys.argv[1]).convert("RGB")
        if master.size != (1024, 1024):
            sys.exit(f"app-icons: master must be 1024x1024, got {master.size[0]}x{master.size[1]}")
    else:
        master = placeholder()
    for rel, kind in CATALOGS:
        write_set(ROOT / rel, kind, master)


if __name__ == "__main__":
    main()
