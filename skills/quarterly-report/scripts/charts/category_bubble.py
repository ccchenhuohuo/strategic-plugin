"""Category growth bubble: legacy tab10 language, evidence-only text."""
from layout import bubble_panel
from style import DPI, MAX_WIDTH_IN, make_figure

LAYOUTS = ["measured-category-neighbours", "tall-category-neighbours", "higher-category-neighbours"]


def render(spec, attempt):
    width, height = MAX_WIDTH_IN[spec["kind"]], [9.2, 11, 13][attempt]
    references = "；".join(ref["label"] for ref in spec["reference"].values())
    fig, (top, bottom) = make_figure(spec, width, height, [references])
    w, h = fig.get_size_inches() * DPI
    ax = fig.add_axes([.075, bottom/h, .90, (h-top-bottom)/h])
    fits = bubble_panel(fig, ax, spec["points"], "category_bubble", attempt, reference=spec["reference"])
    return fig, [] if fits else [{"type": "layout_capacity", "text": "measured label column cannot fit"}]
