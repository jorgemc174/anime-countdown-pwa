"""Crop icon-mobile to remove transparent padding and generate mipmap icons."""
import os
import sys
from PIL import Image

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_PATH = os.path.join(BASE_DIR, "icons", "icon-mobile-512.png")
OUT_DIR = os.path.join(BASE_DIR, "android", "app", "src", "main", "res")

DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

if not os.path.exists(SRC_PATH):
    print(f"Error: icon not found at {SRC_PATH}")
    sys.exit(1)

img = Image.open(SRC_PATH).convert("RGBA")
pixels = img.load()

# Find bounding box of non-transparent pixels
min_x, min_y = img.size[0], img.size[1]
max_x, max_y = 0, 0

for y in range(img.size[1]):
    for x in range(img.size[0]):
        r, g, b, a = pixels[x, y]
        if a > 10:
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)

if max_x > min_x and max_y > min_y:
    cropped = img.crop((min_x, min_y, max_x + 1, max_y + 1))
    # Scale cropped to fill original size
    scaled = cropped.resize(img.size, Image.LANCZOS)
    print(f"Cropped from {img.size} to {cropped.size}, then scaled back to {scaled.size}")
else:
    scaled = img
    print("No transparent padding found, using original")

for folder, size in DENSITIES.items():
    folder_path = os.path.join(OUT_DIR, folder)
    os.makedirs(folder_path, exist_ok=True)
    resized = scaled.resize((size, size), Image.LANCZOS)
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        path = os.path.join(folder_path, name)
        resized.save(path)
        print(f"Created {path} ({size}x{size})")

print("Done!")
