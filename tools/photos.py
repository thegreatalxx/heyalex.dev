#!/usr/bin/env python3
"""Upload a folder of photos to the contact sheet on heyalex.dev.

Each photo is turned upright, resized to 1600 px on its long side and re-encoded with no
metadata at all: no GPS, no serial numbers, nothing personal. Its camera settings are read
first and kept as one line of text, like "Nikon D7200 · 35 mm · f/1.8 · 1/250 s · ISO 200".
Photos appear in file-name order, titled after the file name ("harbour-at-dusk.jpg" becomes
"Harbour at dusk"). Uploading again replaces the whole set.

usage:  STATUS_TOKEN=... python3 tools/photos.py ~/Pictures/for-the-site
        UPLOAD_TOKEN works too. HEYALEX_URL=http://localhost:8787 tries it against wrangler dev.
needs:  Pillow (pip3 install --user Pillow)
"""
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("needs Pillow: pip3 install --user Pillow")

BASE = os.environ.get("HEYALEX_URL", "https://heyalex.dev").rstrip("/")
TOKEN = os.environ.get("UPLOAD_TOKEN") or os.environ.get("STATUS_TOKEN")
KINDS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
MAX_PHOTOS = 60


def slug(name):
    return (re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "photo")[:40].strip("-")


def title(name):
    words = re.sub(r"[-_]+", " ", name).strip()
    return (words[:1].upper() + words[1:])[:80]


def settings(img):
    """one line of camera settings, from tags that say nothing about where or who"""
    exif = img.getexif()
    sub = exif.get_ifd(0x8769)
    model = str(exif.get(0x0110) or "").strip()
    model = model.title() if model.isupper() else model
    parts = [model] if model else []
    focal, fnum, expo, iso = sub.get(0x920A), sub.get(0x829D), sub.get(0x829A), sub.get(0x8827)
    try:
        if focal:
            parts.append(f"{round(float(focal))} mm")
        if fnum:
            parts.append(f"f/{float(fnum):g}")
        if expo:
            e = float(expo)
            parts.append(f"1/{round(1 / e)} s" if 0 < e < 1 else f"{e:g} s")
        if iso:
            parts.append(f"ISO {int(iso[0] if isinstance(iso, tuple) else iso)}")
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    taken = str(sub.get(0x9003) or exif.get(0x0132) or "")
    date = taken[:10].replace(":", "-") if re.match(r"\d{4}:\d\d:\d\d", taken) else ""
    return " · ".join(parts)[:100], date


def clean_jpeg(img):
    """upright, at most 1600 px, re-encoded without exif, xmp or icc data"""
    img = ImageOps.exif_transpose(img)
    img.thumbnail((1600, 1600))
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=82, optimize=True, progressive=True)
    return out.getvalue(), img.size


def put(path, body, kind):
    req = urllib.request.Request(BASE + path, data=body, method="PUT", headers={
        "authorization": "Bearer " + TOKEN, "content-type": kind, "user-agent": "heyalex-photos"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{path}: {e.code} {e.read().decode(errors='replace')[:200]}")


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit(__doc__)
    if not TOKEN:
        sys.exit("set STATUS_TOKEN or UPLOAD_TOKEN")
    files = sorted(f for f in os.listdir(sys.argv[1]) if os.path.splitext(f)[1].lower() in KINDS)
    if not files:
        sys.exit("no photos in that folder")
    if len(files) > MAX_PHOTOS:
        print(f"only the first {MAX_PHOTOS} are used")
        files = files[:MAX_PHOTOS]
    manifest, seen = [], set()
    for f in files:
        stem = os.path.splitext(f)[0]
        pid, n = slug(stem), 2
        while pid in seen:
            pid, n = f"{slug(stem)[:36]}-{n}", n + 1
        seen.add(pid)
        with Image.open(os.path.join(sys.argv[1], f)) as img:
            exif, date = settings(img)
            data, (w, h) = clean_jpeg(img)
        put(f"/api/asset/photo-{pid}.jpg", data, "image/jpeg")
        manifest.append({"id": pid, "title": title(stem), "date": date, "exif": exif, "w": w, "h": h})
        print(f"{f} -> /photo/{pid}.jpg  {w}x{h}  {len(data) // 1024} KB  {exif}")
    put("/api/photos", json.dumps(manifest).encode(), "application/json")
    print(f"{len(manifest)} photos on {BASE} (the site picks up the new list within about five minutes)")


if __name__ == "__main__":
    main()
