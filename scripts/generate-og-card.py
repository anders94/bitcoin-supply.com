#!/usr/bin/env python3
"""Generate public/images/og-card.png — the 1200x630 Open Graph card.

Renders the site's "Ledger" look (warm paper, hairlines, IBM Plex Mono)
as a static social-preview image. Needs Pillow and the IBM Plex Mono TTFs:

    python3 -m venv .og && .og/bin/pip install Pillow
    .og/bin/python scripts/generate-og-card.py

Fonts are fetched into a cache dir on first run (google/fonts, OFL-licensed).
"""
import os
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

# --- Ledger palette (public/stylesheets/ledger.css) ---
PAPER = (251, 250, 247)
INSET = (243, 240, 232)
INK = (27, 26, 22)
BODY = (87, 82, 74)
SECONDARY = (122, 116, 102)
BORDER = (221, 215, 201)
STRIPE_DARK = (201, 195, 178)   # --disabled, used by --stripe-swatch
GREEN = (66, 160, 82)           # ~oklch(0.62 0.17 145)

W, H = 1200, 630

FONT_DIR = os.environ.get('OG_FONT_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '.fonts')
FONT_URL = 'https://github.com/google/fonts/raw/main/ofl/ibmplexmono/IBMPlexMono-{w}.ttf'


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    path = os.path.join(FONT_DIR, f'IBMPlexMono-{weight}.ttf')
    if not os.path.exists(path):
        os.makedirs(FONT_DIR, exist_ok=True)
        urllib.request.urlretrieve(FONT_URL.format(w=weight), path)
    return ImageFont.truetype(path, size)


def tracked(draw: ImageDraw.ImageDraw, xy, text, fnt, fill, tracking=0.0):
    """Draw text with letterspacing; returns end x."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking
    return x - tracking


def tracked_width(draw, text, fnt, tracking=0.0):
    return sum(draw.textlength(c, font=fnt) for c in text) + tracking * (len(text) - 1)


def stripes(img: Image.Image, box, dark, light, period=14):
    """Fill box with 135° diagonal stripes, like the CSS --stripe-swatch."""
    x0, y0, x1, y1 = box
    seg = Image.new('RGB', (x1 - x0, y1 - y0), light)
    d = ImageDraw.Draw(seg)
    w, h = seg.size
    for s in range(-h, w + h, period):
        d.line([(s, 0), (s + h, h)], fill=dark, width=period // 2)
    img.paste(seg, (x0, y0))


def main() -> None:
    img = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # Frame
    M = 42
    d.rectangle([M, M, W - M, H - M], outline=INK, width=2)
    inner_l, inner_r = M + 46, W - M - 46

    # Header row: wordmark left, live dot right, hairline below
    wm_f = font('SemiBold', 27)
    tracked(d, (inner_l, M + 40), 'BITCOIN·SUPPLY', wm_f, INK, tracking=4.5)

    tag_f = font('Medium', 19)
    tag = 'LEDGER OF EVERY COIN'
    tag_w = tracked_width(d, tag, tag_f, 3.5)
    dot_r = 7
    dot_x = inner_r - tag_w - 26
    d.ellipse([dot_x - dot_r, M + 44 + 6, dot_x + dot_r, M + 44 + 6 + 2 * dot_r],
              fill=GREEN)
    tracked(d, (inner_r - tag_w, M + 44), tag, tag_f, SECONDARY, tracking=3.5)

    rule_y = M + 104
    d.line([inner_l, rule_y, inner_r, rule_y], fill=INK, width=2)

    # Headline
    h_f = font('SemiBold', 67)
    d.text((inner_l - 2, rule_y + 42), 'THE EFFECTIVE', font=h_f, fill=INK)
    d.text((inner_l - 2, rule_y + 42 + 82), 'SUPPLY OF BITCOIN', font=h_f, fill=INK)

    # Subline
    s_f = font('Regular', 24)
    d.text((inner_l, rule_y + 244),
           'How much of the 21M cap is provably lost, probably lost,',
           font=s_f, fill=BODY)
    d.text((inner_l, rule_y + 244 + 36),
           'dormant or quantum-exposed — measured UTXO by UTXO.',
           font=s_f, fill=BODY)

    # Supply bar: solid ink = effective, striped tail = lost
    bar_t, bar_b = 512, 558
    lost_frac = 0.14
    split_x = int(inner_l + (inner_r - inner_l) * (1 - lost_frac))
    d.rectangle([inner_l, bar_t, split_x, bar_b], fill=INK)
    stripes(img, (split_x, bar_t, inner_r, bar_b), STRIPE_DARK, INSET)
    d.rectangle([inner_l, bar_t, inner_r, bar_b], outline=INK, width=2)

    lbl_f = font('Medium', 17)
    tracked(d, (inner_l, bar_t - 32), 'EFFECTIVE SUPPLY', lbl_f, INK, tracking=2.5)
    lost = 'LOST'
    lw = tracked_width(d, lost, lbl_f, 2.5)
    tracked(d, (inner_r - lw, bar_t - 32), lost, lbl_f, SECONDARY, tracking=2.5)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       '..', 'public', 'images', 'og-card.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, optimize=True)
    print(f'wrote {os.path.normpath(out)}')


if __name__ == '__main__':
    sys.exit(main())
