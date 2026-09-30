"""Frozen visual language. This module performs geometry, never business arithmetic."""
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
from matplotlib import font_manager, pyplot as plt
from matplotlib.ticker import FuncFormatter, MaxNLocator

DPI = 180
# Legacy widths also bound every retry: images are inserted at 800 px wide,
# so extra horizontal canvas would shrink all of their text in the report.
MAX_WIDTH_IN = {"category_bubble": 16.0, "segment_matrix": 16.0,
                "price_band": 24.0, "brand_bubble": 14.8}
COLORS = plt.cm.tab10.colors
MARKERS = ["o", "s", "^", "D", "P", "X", "v", "<", ">", "*"]
FONT_CANDIDATES = (
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc",
)


def setup_font():
    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            font_manager.fontManager.addfont(candidate)
            name = font_manager.FontProperties(fname=candidate).get_name()
            plt.rcParams.update({"font.family": name, "axes.unicode_minus": False,
                                 "font.size": 10, "figure.dpi": DPI,
                                 "savefig.dpi": DPI, "text.antialiased": True})
            return candidate
    return None


def number(value):
    # Evidence raw decimals may only be converted for coordinates / marker geometry.
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("non-finite geometry")
    return value


def cny_tick(value, _):
    # Axis tick labels are generated geometry, not evidence/data claims.
    if value == 0:
        return "0"
    return f"{value / 1e8:g}亿" if abs(value) >= 1e8 else f"{value / 1e4:g}万"


def axes_style(ax, xkind="money", ykind="percent"):
    ax.grid(False)
    for spine in ax.spines.values():
        spine.set_color("#333333")
        spine.set_linewidth(1.0)
    ax.tick_params(labelsize=9, colors="#555555", pad=5)
    ax.xaxis.set_major_formatter(FuncFormatter(cny_tick if xkind == "money" else lambda v, _: "0" if v == 0 else f"{v:g}%"))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: "0" if v == 0 else f"{v:g}{'pp' if ykind == 'pp' else '%'}"))
    ax.yaxis.set_major_locator(MaxNLocator(nbins=5))


def measure(fig, text, fontsize=9.8):
    t = fig.text(0, 0, text, fontsize=fontsize, linespacing=1.35)
    box = t.get_window_extent(fig.canvas.get_renderer())
    result = (box.width, box.height)
    t.remove()
    return result


def footer_lines(spec):
    lines = list(spec["notes"])
    grouped = {}
    for item in spec["excluded"]:
        group = grouped.setdefault(item['status'], {'reasons': [], 'names': []})
        reason = item['reason'] or item['status']
        if reason not in group['reasons']:
            group['reasons'].append(reason)
        if item['name'] not in group['names']:
            group['names'].append(item['name'])
    lines.extend('；'.join(group['reasons']) + '：' + '、'.join(group['names']) for group in grouped.values())
    return lines


def wrap_text(fig, text, width, fontsize=8.5):
    """Only insert line breaks for geometry; preserve every original character."""
    result, line = [], ""
    for char in text:
        if char == "\n":
            result.append(line)
            line = ""
        elif line and measure(fig, line + char, fontsize)[0] > width:
            result.append(line)
            line = char
        else:
            line += char
    if line:
        result.append(line)
    return result


def make_figure(spec, width, height, extra_notes=(), title_size=16):
    if width > MAX_WIDTH_IN[spec["kind"]]:
        raise ValueError("chart canvas exceeds legacy width limit")
    fig = plt.figure(figsize=(width, height), dpi=DPI)
    fig._fw_chart_kind = spec["kind"]
    # Titles and data footnotes occupy measured figure regions, apart from axes.
    pxwidth = width * DPI
    title_lines = wrap_text(fig, spec["title"], pxwidth - 100, title_size)
    subtitle_lines = wrap_text(fig, spec["subtitle"], pxwidth - 100, 10) if spec["subtitle"] else []
    foot = []
    for line in dict.fromkeys([*footer_lines(spec), *extra_notes]):
        foot.extend(wrap_text(fig, line, pxwidth - 100, 8.5))
    top = 32 + len(title_lines) * 43 + len(subtitle_lines) * 27
    bottom = 120 + len(foot) * 25
    minheight = (top + bottom + 450) / DPI
    if height < minheight:
        fig.set_size_inches(width, minheight)
        height = minheight
    pxheight = height * DPI
    y = pxheight - 24
    for line in title_lines:
        fig.text(50 / pxwidth, y / pxheight, line, ha="left", va="top", fontsize=title_size)
        y -= 43
    for line in subtitle_lines:
        fig.text(50 / pxwidth, y / pxheight, line, ha="left", va="top", fontsize=10, color="#666666")
        y -= 27
    y = 20 + (len(foot) - 1) * 25
    for line in foot:
        fig.text(50 / pxwidth, y / pxheight, line, ha="left", va="bottom", fontsize=8.5, color="#666666")
        y -= 25
    return fig, (top, bottom)


def save_png(fig, target):
    # Fixed image canvas: audit text_clipped against exactly the saved pixel bounds.
    # No tight crop, timestamps or matplotlib software/version metadata.
    fig.savefig(target, facecolor="white", dpi=DPI,
                metadata={"Software": None, "Creation Time": None})
