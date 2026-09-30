"""Brand bubble diameter and rank badges preserve the legacy visual language."""
from layout import bubble_panel
from style import DPI, MAX_WIDTH_IN, make_figure

LAYOUTS = ["measured-brand-two-columns-short-leaders", "tall-brand-two-columns-short-leaders", "higher-brand-two-columns-short-leaders", "expanded-brand-two-columns-short-leaders"]


def render(spec, attempt):
    width, height = MAX_WIDTH_IN[spec["kind"]], [8.2, 10.5, 13, 16][attempt]
    fig, (top, bottom) = make_figure(spec, width, height)
    w, h = fig.get_size_inches() * DPI
    ax = fig.add_axes([.075, bottom/h, .90, (h-top-bottom)/h])
    fits = bubble_panel(fig, ax, spec["points"], "brand_bubble", attempt)
    return fig, [] if fits else [{"type": "layout_capacity", "text": "measured labels or short leaders cannot fit"}]
