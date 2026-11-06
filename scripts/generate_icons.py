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

# Logo width as a share of the visible icon, measured on the target launcher.
LOGO_VISIBLE_WIDTH = 0.713
VISIBLE_SHARE = 72 / 108


def extract_logo(source):
    """Return the orange logo with a transparent background, cropped tightly."""
    rgb = source.convert("RGB")
    alpha = rgb.getchannel("R").point(lambda red: max(0, min(255, (red - 60) * 255 // 140)))
    logo = rgb.convert("RGBA")
    logo.putalpha(alpha)
    return logo.crop(alpha.point(lambda value: 255 if value > 40 else 0).getbbox())


def adaptive_foreground(logo, size):
    """Center the logo on a transparent adaptive layer of the given size."""
    width = round(size * VISIBLE_SHARE * LOGO_VISIBLE_WIDTH)
    height = round(width * logo.height / logo.width)
    resized = logo.convert("RGBa").resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.alpha_composite(resized, ((size - width) // 2, (size - height) // 2))
    return layer


logo = extract_logo(Image.open(ICON_PATH))
legacy_img = Image.open(LEGACY_ICON_PATH).convert("RGBA")

for folder, size in DENSITIES.items():
    folder_path = os.path.join(OUT_DIR, folder)
    os.makedirs(folder_path, exist_ok=True)
    resized = legacy_img.resize((size, size), Image.Resampling.LANCZOS)
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        path = os.path.join(folder_path, name)
        resized.save(path)
        print(f"Created {path} ({size}x{size})")

    # Adaptive layers occupy 108dp, of which launchers show the central 72dp.
    adaptive_size = size * 108 // 48
    path = os.path.join(folder_path, "ic_launcher_foreground.png")
    adaptive_foreground(logo, adaptive_size).save(path)
    print(f"Created {path} ({adaptive_size}x{adaptive_size})")

print("Done!")
