"""Generate Android mipmap icons from the PWA maskable icon."""
import os
import sys
from PIL import Image

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_PATH = os.path.join(BASE_DIR, "icons", "icon-mobile-512.png")
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

for folder, size in DENSITIES.items():
    folder_path = os.path.join(OUT_DIR, folder)
    os.makedirs(folder_path, exist_ok=True)
    resized = img.resize((size, size), Image.LANCZOS)
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        path = os.path.join(folder_path, name)
        resized.save(path)
        print(f"Created {path} ({size}x{size})")

print("Done!")
