"""Policy-ordered paired stacks, connecting polygons, growth column and ASP row."""
from matplotlib.patches import Polygon, Rectangle
from layout import connector_route
from style import COLORS, DPI, MAX_WIDTH_IN, make_figure, measure, number

LAYOUTS = ["measured-share-labels", "tall-share-labels", "higher-share-labels"]


def render(spec, attempt):
    width, height = MAX_WIDTH_IN[spec["kind"]], [9.2, 11, 13][attempt]
    fig, (top, bottom) = make_figure(spec, width, height, ["未标注的档位数值见表 " + spec["before_table"]])
    # A missing policy member does not shift colors of subsequent observed bands.
    color_by_band = {band["name"]: COLORS[i % 10] for i, band in enumerate(spec["bands"])}
    w, h = fig.get_size_inches()*DPI
    legend_width = max([measure(fig, b["name"], 10)[0] for b in spec["bands"]]+[80])+52
    left, usable = 40+legend_width, w-80-legend_width
    scopes = len(spec["ranges"])
    scopewidth = usable/max(scopes, 1)
    plotbottom = bottom+98
    plotheight = h-top-plotbottom-90
    legend_x = 44
    for i, band in enumerate(spec["bands"]):
        y = h-top-28-i*39
        fig.patches.append(Rectangle((legend_x/w, (y-8)/h), 15/w, 15/h, transform=fig.transFigure, facecolor=COLORS[i % 10], edgecolor="none"))
        fig.text((legend_x+24)/w, y/h, band["name"], fontsize=10, va="center")
    issues = []
    for index, scope in enumerate(spec["ranges"]):
        x = left+index*scopewidth
        panelwidth = scopewidth*.57
        ax = fig.add_axes([x/w, plotbottom/h, (panelwidth-15)/w, plotheight/h])
        ax.set_xlim(-.35, 1.35)
        ax.set_ylim(0, 100)
        ax.set_xticks([0, 1], ["对照期", "当期"], fontsize=10)
        ax.set_yticks([])
        ax.set_title(scope["name"], fontsize=13, pad=14, color="#555555")
        for spine in ax.spines.values():
            spine.set_color("#CCCCCC")
        oldbottom = currentbottom = 0
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        labels = []
        narrow = []
        for i, band in enumerate(scope["bands"]):
            oldheight, currentheight = number(band["yoy"]), number(band["current"])
            color = color_by_band[band["name"]]
            # Cumulative positions are permitted stacking geometry, not new claims.
            ax.add_patch(Polygon([(0, oldbottom), (0, oldbottom+oldheight), (1, currentbottom+currentheight), (1, currentbottom)], facecolor=color, edgecolor="none", alpha=.72))
            ax.add_patch(Rectangle((-.075, oldbottom), .15, oldheight, facecolor=color, edgecolor="white", linewidth=.35))
            ax.add_patch(Rectangle((.925, currentbottom), .15, currentheight, facecolor=color, edgecolor="white", linewidth=.35))
            for side, bh, base, label in ((0, oldheight, oldbottom, band["yoy_label"]), (1, currentheight, currentbottom, band["current_label"])):
                tw, th = measure(fig, label, 9.1)
                pixelheight = bh/100*plotheight
                if pixelheight >= th+7 and tw < panelwidth*.45:
                    t = ax.text(side, base+bh/2, label, fontsize=9.1, ha="center", va="center", bbox={"facecolor":"white","edgecolor":"none","alpha":.92,"pad":1}, zorder=4)
                    t._fw_label = True
                    labels.append(t)
                else:
                    narrow.append((side, base+bh/2, label, th, tw))
            oldbottom += oldheight
            currentbottom += currentheight
        # Try external measured columns for narrow policy bands. If capacity is
        # exhausted, omit their labels and refer readers to the source table.
        exterior = []
        for side in (0, 1):
            pending = sorted([p for p in narrow if p[0] == side], key=lambda p: p[1])
            cursor = 10
            for _, midpoint, label, th, tw in pending:
                target = max(cursor+th/2, midpoint/100*plotheight)
                if target+th/2 > plotheight-8 or tw > (panelwidth-15)*.18:
                    continue
                ty = target/plotheight*100
                tx = -.24 if side == 0 else 1.24
                t = ax.text(tx, ty, label, fontsize=8.2, ha="center", va="center", bbox={"facecolor":"white","edgecolor":"none","alpha":.98,"pad":1}, zorder=5)
                t._fw_label = True
                exterior.append((side, midpoint, t))
                cursor = target+th/2+6
        fig.canvas.draw()
        all_labels = labels + [item[2] for item in exterior]
        bounds = tuple(ax.get_window_extent(renderer).extents)
        inverse = ax.transData.inverted()
        for side, midpoint, t in exterior:
            box = t.get_window_extent(renderer)
            source = tuple(ax.transData.transform((-.09 if side == 0 else 1.09, midpoint)))
            target = (box.x1+3 if side == 0 else box.x0-3, (box.y0+box.y1)/2)
            boxes = [tuple(other.get_window_extent(renderer).extents) for other in all_labels if other is not t]
            route = inverse.transform(connector_route(source, target, boxes, bounds))
            line, = ax.plot(route[:, 0], route[:, 1], color="#888888", lw=.6, zorder=3)
            line._fw_connector = True
            line._fw_owner_text = t
        gx, gw = x+panelwidth+7, scopewidth-panelwidth-20
        growthax = fig.add_axes([gx/w, plotbottom/h, gw/w, plotheight/h])
        growthax.set_xlim(0, 1)
        growthax.set_ylim(0, len(scope["bands"]))
        growthax.axis("off")
        growthax.set_title("档位同比", fontsize=10, pad=14, color="#555555")
        n = len(scope["bands"])
        for i, band in enumerate(scope["bands"]):
            # Policy response order stacks bottom to top; the adjacent growth
            # rows follow the same order, with the highest band at the top.
            y = i
            growthax.add_patch(Rectangle((0, y), 1, 1, facecolor="#F4F4F4" if i % 2 == 0 else "white", edgecolor="none"))
            label = band["name"]+"\n"+band["growth_label"]
            tw, th = measure(fig, label, 9)
            if tw > gw-5 or th > plotheight/max(n, 1)-5:
                issues.append({"type":"layout_capacity","text":label})
            t = growthax.text(.5, y+.5, label, fontsize=9, ha="center", va="center", linespacing=1.35)
            t._fw_label = True
        growthax.add_patch(Rectangle((0, 0), 1, n, facecolor="none", edgecolor="#CCCCCC", linewidth=.7))
        # ASP string is already fully composed from response displays by Node.
        asp = scope["asp_label"]
        aspwidth = measure(fig, asp, 9)[0]
        if aspwidth > scopewidth-15:
            # Split only at the punctuation separating the two display strings.
            asp = asp.replace("，对照期", "，\n对照期")
        fig.text((x+scopewidth/2)/w, (plotbottom-56)/h, asp, fontsize=9, ha="center", va="center", linespacing=1.35)
    return fig, issues
