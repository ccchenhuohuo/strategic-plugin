"""Configured sites, consistent segment colors/markers, no client mean lines."""
import math
from matplotlib.lines import Line2D
from layout import bubble_panel
from style import COLORS, DPI, MARKERS, MAX_WIDTH_IN, make_figure, measure, number

LAYOUTS = ["measured-matrix-short-leaders", "grid-matrix-short-leaders", "tall-grid-matrix-short-leaders"]


def render(spec, attempt):
    # A failed row becomes a two-column grid; later retries only add height.
    grid = spec["layout"] == "grid" or attempt > 0
    width = MAX_WIDTH_IN[spec["kind"]]
    grid_retry = attempt if spec["layout"] == "grid" else max(0, attempt-1)
    height = (11.5 + grid_retry*3) if grid else 7.8
    fig, (top, bottom) = make_figure(spec, width, height)
    fig._fw_panel_layout = "grid" if grid else "row"
    w, h = fig.get_size_inches() * DPI
    # Measured legend occupies separate rows beneath the title/subtitle.
    fontsize, x, y = 9.5, 60, h-top-16
    rowheight = max([measure(fig, name, fontsize)[1] for name in spec['segments']]+[24])+12
    legend_texts = []
    for i, name in enumerate(spec["segments"]):
        labelwidth = measure(fig, name, fontsize)[0] + 54
        if x + labelwidth > w - 50:
            x, y = 60, y-rowheight
        fig.add_artist(Line2D([(x+7)/w], [y/h], transform=fig.transFigure,
                              marker=MARKERS[i % len(MARKERS)], markersize=7,
                              color=COLORS[i % 10], linestyle="none"))
        text = fig.text((x+23)/w, y/h, name, fontsize=fontsize, va="center")
        legend_texts.append(text)
        x += labelwidth
    fig.canvas.draw()
    # Panel titles extend above the axes by their measured glyph height plus
    # title padding. Reserve that space below the entire legend box.
    legend_bottom = min([t.get_window_extent(fig.canvas.get_renderer()).y0 for t in legend_texts]+[y-12])
    panel_title_height = max([measure(fig, panel['name'], 13)[1] for panel in spec['panels']]+[32])
    top = h-legend_bottom+panel_title_height+14*DPI/72+24
    columns = 2 if grid else max(1, len(spec["panels"]))
    rows = math.ceil(len(spec["panels"])/columns)
    left, right, horizontal_gap, vertical_gap = .075*w, .03*w, 80, 190
    pw = (w-left-right-(columns-1)*horizontal_gap)/columns
    ph = (h-top-bottom-(rows-1)*vertical_gap)/rows
    issues = []
    # Common raw-value extrema only set panel geometry. This preserves the old
    # sharey matrix: hidden ticks in other columns have the same coordinate scale.
    ys = [number(point["y"]) for panel in spec["panels"] for point in panel["points"]] + [0]
    ymin, ymax = min(ys), max(ys)
    pad = max(ymax-ymin, 1)*.20
    ylimits = (ymin-pad, ymax+pad)
    for i, panel in enumerate(spec["panels"]):
        row, col = divmod(i, columns)
        ax = fig.add_axes([(left+col*(pw+horizontal_gap))/w, (h-top-(row+1)*ph-row*vertical_gap)/h, pw/w, ph/h])
        if not bubble_panel(fig, ax, panel["points"], "segment_matrix", attempt, title=panel["name"], ylimits=ylimits):
            issues.append({"type": "layout_capacity", "text": panel["name"] + " measured labels or short leaders cannot fit"})
        if col:
            ax.set_ylabel("")
            ax.tick_params(axis="y", labelleft=False)
    return fig, issues
