"""Generate legacy and adaptive Android launcher icons (requires Pillow)."""
import os
import sys
from PIL import Image

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_PATH = os.path.join(BASE_DIR, "icons", "icon-mobile-512.png")
LEGACY_ICON_PATH = os.path.join(BASE_DIR, "icons", "icon-512.png")
OUT_DIR = os.path.join(BASE_DIR, "android", "app", "src", "main", "res")

DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

if not os.path.exists(ICON_PATH):
    print(f"Error: icon not found at {ICON_PATH}")
    sys.exit(1)

img = Image.open(ICON_PATH).convert("RGBA")
legacy_img = Image.open(LEGACY_ICON_PATH).convert("RGBA")

for folder, size in DENSITIES.items():
    folder_path = os.path.join(OUT_DIR, folder)
    os.makedirs(folder_path, exist_ok=True)
    resized = legacy_img.resize((size, size), Image.Resampling.LANCZOS)
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        path = os.path.join(folder_path, name)
        resized.save(path)
        print(f"Created {path} ({size}x{size})")

    # Adaptive layers occupy 108dp rather than the legacy icon's 48dp.
    # The mobile artwork already keeps its logo inside the central 66dp safe
    # area, so circular and rounded launcher masks do not crop the logo.
    adaptive_size = size * 108 // 48
    path = os.path.join(folder_path, "ic_launcher_foreground.png")
    img.resize((adaptive_size, adaptive_size), Image.Resampling.LANCZOS).save(path)
    print(f"Created {path} ({adaptive_size}x{adaptive_size})")

print("Done!")
