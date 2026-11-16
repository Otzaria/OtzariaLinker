"""PNG screenshots → small WebP for the docs (docs/reviews/UX_AUDIT_V5.md, ux2-alternatives/).

Usage: py -I scripts/audit/to_webp.py <out-dir> <src.png>[=<name>] …
Each image is scaled to at most 1100px wide (a portrait one to 620px) and saved as <name>.webp, quality 72.
"""
import os, sys
from PIL import Image

out, *items = sys.argv[1:]
os.makedirs(out, exist_ok=True)
for it in items:
    src, _, name = it.partition("=")
    name = name or os.path.splitext(os.path.basename(src))[0]
    im = Image.open(src).convert("RGB")
    w = 620 if im.height > im.width else 1100
    if im.width > w:
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(os.path.join(out, name + ".webp"), "WEBP", quality=72, method=6)
