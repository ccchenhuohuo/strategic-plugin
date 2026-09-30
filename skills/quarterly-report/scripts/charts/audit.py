"""Deterministic, display-pixel layout gate for the quarterly-report charts.

Only Text artists whose ``draw`` method was actually invoked are inspected.
In particular, asking an axis for tick labels here would manufacture hidden
ticks, and RendererAgg.draw_text does not retain the artist for multiline text.
No business values are calculated: all arithmetic below is pixel geometry.

Renderer hints: ``_fw_label`` marks a text as an
in-axes data label (False means an intentional margin label), ``_fw_connector``
marks a Line2D as a leader, and ``_fw_owner_text`` identifies its own Text artist.
Circular text bboxes are rank badges and exempt only from text_bubble.
``_fw_source_xy`` and ``_fw_source_disc`` identify one source marker by its
center and collection/offset. Its overlap component earns bubble/crossing
exemptions; reference runs exclude only the source marker itself. Text
collisions keep their original narrow exemptions.
"""

import math
from dataclasses import dataclass

from matplotlib.collections import PathCollection
from matplotlib.lines import Line2D
from matplotlib.patches import BoxStyle, Rectangle
from matplotlib.path import Path
from matplotlib.text import Annotation, Text
from matplotlib.transforms import IdentityTransform


BUBBLE_TOLERANCE_PX = 1.0
CONNECTOR_BUBBLE_GAP_PX = 2.0
TEXT_GAP_PX = 2.0
CLUSTER_GAP_PX = 2.0
CLUSTER_CROSSING_PAD_PX = 6.0
REFLINE_BAND_PX = 4.0
REFLINE_RUN_PX = 40.0
DETOUR_KINDS = frozenset(("category_bubble", "brand_bubble", "segment_matrix"))
_EPS = 1e-6


@dataclass
class Disc:
    cx: float
    cy: float
    radius: float
    clip: object
    collection: object
    index: int


@dataclass
class Connector:
    owner: object
    segments: list
    source: object
    source_disc: object = None
    bends: int = 0
    axes: object = None


def disc_clusters(circles):
    """Stable connected components of (cx, cy, radius), with a 2 px gap."""
    parents = list(range(len(circles)))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for i, (cx, cy, radius) in enumerate(circles):
        for j in range(i):
            x, y, r = circles[j]
            if math.hypot(cx-x, cy-y) <= radius+r+CLUSTER_GAP_PX:
                a, b = root(i), root(j)
                parents[max(a, b)] = min(a, b)
    return [root(i) for i in range(len(circles))]


def point_segment_distance(point, start, end):
    """Distance in display pixels, including the two segment endpoints."""
    dx, dy = end[0] - start[0], end[1] - start[1]
    length2 = dx * dx + dy * dy
    t = 0 if length2 == 0 else max(0, min(1, ((point[0]-start[0])*dx + (point[1]-start[1])*dy)/length2))
    return math.hypot(point[0]-start[0]-t*dx, point[1]-start[1]-t*dy)


def segment_intersection(a, b, c, d):
    """Return the intersection point(s); a positive collinear overlap has two."""
    cross = lambda u, v: u[0]*v[1] - u[1]*v[0]
    r, s, delta = (b[0]-a[0], b[1]-a[1]), (d[0]-c[0], d[1]-c[1]), (c[0]-a[0], c[1]-a[1])
    denom = cross(r, s)
    if abs(denom) > _EPS:
        t, u = cross(delta, s)/denom, cross(delta, r)/denom
        if -_EPS <= t <= 1+_EPS and -_EPS <= u <= 1+_EPS:
            return [(a[0]+t*r[0], a[1]+t*r[1])]
        return []
    if abs(cross(delta, r)) > _EPS:
        return []
    axis = 0 if abs(r[0]) >= abs(r[1]) else 1
    if abs(r[axis]) < _EPS:
        return [a] if point_segment_distance(a, c, d) < _EPS else []
    t1, t2 = (c[axis]-a[axis])/r[axis], (d[axis]-a[axis])/r[axis]
    lo, hi = max(0, min(t1, t2)), min(1, max(t1, t2))
    if lo > hi + _EPS:
        return []
    first = (a[0]+lo*r[0], a[1]+lo*r[1])
    return [first] if hi-lo < _EPS else [first, (a[0]+hi*r[0], a[1]+hi*r[1])]


def _inside_cluster(points, cluster):
    """The entire intersection must lie in the union of 6 px expanded discs.

    For collinear overlap, testing just its endpoints would wrongly exempt an
    uncovered interval between two members of a connected component.
    """
    if not cluster:
        return False
    start = points[0]
    if len(points) == 1:
        return any(math.hypot(start[0]-cx, start[1]-cy) <= r+CLUSTER_CROSSING_PAD_PX
                   for cx, cy, r in cluster)
    end = points[1]
    dx, dy = end[0]-start[0], end[1]-start[1]
    length2 = dx*dx+dy*dy
    intervals = []
    for cx, cy, radius in cluster:
        t = ((cx-start[0])*dx+(cy-start[1])*dy)/length2
        distance2 = (cx-start[0]-t*dx)**2+(cy-start[1]-t*dy)**2
        remaining = (radius+CLUSTER_CROSSING_PAD_PX)**2-distance2
        if remaining >= 0:
            delta = math.sqrt(remaining/length2)
            intervals.append((max(0, t-delta), min(1, t+delta)))
    covered = 0.0
    for lo, hi in sorted(intervals):
        if lo > covered or hi < covered:
            continue
        covered = max(covered, hi)
        if covered >= 1:
            return True
    return False


def connector_crossing(first, second, cluster=()):
    """Shared whole-path endpoints and intersections inside a shared cluster."""
    if not first or not second:
        return None
    endpoints_a, endpoints_b = (first[0][0], first[-1][1]), (second[0][0], second[-1][1])
    shared = [a for a in endpoints_a for b in endpoints_b if math.dist(a, b) < _EPS]
    for a, b in first:
        for c, d in second:
            crossing = segment_intersection(a, b, c, d)
            if crossing and (len(crossing) > 1 or not any(math.dist(crossing[0], end) < _EPS for end in shared)):
                if _inside_cluster(crossing, cluster):
                    continue
                return a, b, c, d, crossing
    return None


def _rect(bbox):
    return (float(bbox.x0), float(bbox.y0), float(bbox.x1), float(bbox.y1))


def _pixels(values):
    return [round(float(value), 2) for value in values]


def _finite(values):
    try:
        return all(math.isfinite(float(value)) for value in values)
    except (TypeError, ValueError):
        return False


def _intersection(a, b):
    box = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return box if box[2] > box[0] and box[3] > box[1] else None


def _rect_circle_depth(box, cx, cy, radius):
    nx = min(max(cx, box[0]), box[2])
    ny = min(max(cy, box[1]), box[3])
    return radius - math.hypot(cx - nx, cy - ny)


def _is_badge(text):
    patch = text.get_bbox_patch()
    # Only a circular rank number earns the bubble exemption. Giving a data
    # label a circular background must never hide its bubble collision.
    return (patch is not None and isinstance(patch.get_boxstyle(), BoxStyle.Circle)
            and text.get_text().strip().isdecimal())


def _visible(artist):
    if not artist.get_visible():
        return False
    alpha = artist.get_alpha()
    if alpha is None:
        return True
    try:
        return float(alpha) != 0
    except (TypeError, ValueError):
        # Collections may have per-marker alpha instead of a scalar alpha.
        return any(float(value) != 0 for value in alpha)


def _drawn_artists(fig):
    """Record paint order, including multiline Annotation's Text.draw call."""
    texts, collections, lines, annotations = [], [], [], []
    seen_texts, seen_collections, seen_lines = set(), set(), set()
    original_text = Text.draw
    original_collection = PathCollection.draw
    original_line = Line2D.draw

    def text_draw(self, renderer):
        result = original_text(self, renderer)
        if isinstance(self, Annotation) and _visible(self) and id(self) not in seen_texts:
            annotations.append(self)
        if _visible(self) and self.get_text().strip() and id(self) not in seen_texts:
            seen_texts.add(id(self))
            # Base Text's extent excludes Annotation arrows, as required.
            box = _rect(Text.get_window_extent(self, renderer))
            if _finite(box) and box[2] > box[0] and box[3] > box[1]:
                texts.append((self, box))
        return result

    def collection_draw(self, renderer):
        result = original_collection(self, renderer)
        if _visible(self) and id(self) not in seen_collections:
            seen_collections.add(id(self))
            collections.append(self)
        return result

    def line_draw(self, renderer):
        result = original_line(self, renderer)
        if _visible(self) and id(self) not in seen_lines:
            seen_lines.add(id(self))
            lines.append(self)
        return result

    Text.draw, PathCollection.draw, Line2D.draw = text_draw, collection_draw, line_draw
    try:
        fig.canvas.draw()
    finally:
        Text.draw, PathCollection.draw, Line2D.draw = original_text, original_collection, original_line
    return texts, collections, lines, annotations


def _text_roles(fig):
    """Use existing Tick.label1/label2 objects; never generate tick labels."""
    roles, owners = {}, {}
    for ax in fig.axes:
        for axis in (ax.xaxis, ax.yaxis):
            roles[id(axis.label)] = "axis_label"
            owners[id(axis.label)] = ax
            roles[id(axis.offsetText)] = "axis_label"
            owners[id(axis.offsetText)] = ax
            for tick in (*axis.majorTicks, *axis.minorTicks):
                for label in (tick.label1, tick.label2):
                    roles[id(label)] = "tick"
                    # Tick Text.axes is normally None, so ownership is explicit.
                    owners[id(label)] = ax
        for title in (ax.title, ax._left_title, ax._right_title):
            roles[id(title)] = "title"
            owners[id(title)] = ax
        if ax.legend_ is not None:
            for text in (*ax.legend_.get_texts(), ax.legend_.get_title()):
                roles[id(text)] = "legend"
                owners[id(text)] = ax
    for legend in fig.legends:
        for text in (*legend.get_texts(), legend.get_title()):
            roles[id(text)] = "legend"
    return roles, owners


def _clip_rect(artist, axes_boxes):
    if not artist.get_clip_on():
        return None
    clip = artist.get_clip_box()
    if clip is not None:
        return _rect(clip)
    # The ordinary scatter/line clip path is its axes patch.
    return axes_boxes.get(artist.axes) if artist.get_clip_path() is not None else None


def _discs(collections, dpi, axes_boxes):
    discs = []
    for collection in collections:
        offsets, sizes = collection.get_offsets(), collection.get_sizes()
        if len(offsets) == 0 or len(sizes) == 0:
            continue
        centers = collection.get_offset_transform().transform(offsets)
        clip = _clip_rect(collection, axes_boxes)
        for index, center in enumerate(centers):
            if not _finite(center):
                continue
            size = sizes[index % len(sizes)]
            if not _finite((size,)) or float(size) <= 0:
                continue
            radius = math.sqrt(float(size)) / 2 * dpi / 72
            cx, cy = (float(value) for value in center)
            if clip is not None and _rect_circle_depth(clip, cx, cy, radius) <= 0:
                continue
            discs.append(Disc(cx, cy, radius, clip, collection, index))
    return discs


def _segment_in_rect(start, end, box):
    """Liang-Barsky clipping; None for a zero-length or nonintersecting line."""
    x0, y0 = start
    dx, dy = end[0] - x0, end[1] - y0
    if abs(dx) < _EPS and abs(dy) < _EPS:
        return None
    lo, hi = 0.0, 1.0
    for p, q in ((-dx, x0 - box[0]), (dx, box[2] - x0),
                 (-dy, y0 - box[1]), (dy, box[3] - y0)):
        if abs(p) < _EPS:
            if q < 0:
                return None
        elif p < 0:
            lo = max(lo, q / p)
        else:
            hi = min(hi, q / p)
        if lo >= hi:
            return None
    return ((x0 + lo * dx, y0 + lo * dy), (x0 + hi * dx, y0 + hi * dy))


def _path_segments(path):
    """Flatten arrow curves deterministically; do not join separate subpaths."""
    previous, first = None, None
    for vertices, code in path.iter_segments(curves=False, simplify=False):
        if code == Path.STOP:
            break
        if code == Path.MOVETO:
            previous = first = (float(vertices[0]), float(vertices[1]))
        elif code == Path.CLOSEPOLY:
            if previous is not None and first is not None:
                yield previous, first
            previous = first
        else:
            point = (float(vertices[-2]), float(vertices[-1]))
            if previous is not None and _finite((*previous, *point)) and math.dist(previous, point) > _EPS:
                yield previous, point
            previous = point


def _path_bends(path):
    """Count logical bends before flattening: a smooth curve is one bend.

    Consecutive collinear forward line pieces do not introduce an elbow;
    separate subpaths still contribute pieces without inventing a connecting
    line. Tangential line/curve joins do not add elbows (rounded angle), and
    angle3's CURVE3 control points are not line elbows.
    """
    bends, painted = 0, False
    previous, first, direction, curved = None, None, None, False

    def turns(before, after):
        return (before is not None and after is not None
                and (abs(before[0]*after[1]-before[1]*after[0]) > _EPS
                     or before[0]*after[0]+before[1]*after[1] <= 0))

    for vertices, code in path.iter_segments(curves=True, simplify=False):
        if code == Path.STOP:
            break
        if code == Path.MOVETO:
            if painted:
                bends += 1
            previous = first = tuple(vertices[:2])
            direction, curved = None, False
            continue
        point = first if code == Path.CLOSEPOLY else tuple(vertices[-2:])
        if previous is None or point is None or not _finite((*previous, *point)):
            previous, direction, curved = point, None, False
            continue
        delta = (point[0]-previous[0], point[1]-previous[1])
        if code in (Path.CURVE3, Path.CURVE4):
            controls = [previous, *[tuple(vertices[i:i+2]) for i in range(0, len(vertices), 2)]]
            tangents = [(b[0]-a[0], b[1]-a[1]) for a, b in zip(controls, controls[1:]) if math.dist(a, b) > _EPS]
            incoming = tangents[0] if tangents else None
            bends += int(turns(direction, incoming))+int(not curved)
            direction, curved = (tangents[-1] if tangents else None), True
            painted = True
        elif math.hypot(*delta) > _EPS:
            bends += int(turns(direction, delta))
            direction, curved, painted = delta, False, True
        previous = point
    return bends


def connector_geometry(connector):
    """R3 uses the actual clipped, flattened display path and its endpoints."""
    segments = connector.segments
    length = sum(math.dist(a, b) for a, b in segments)
    distance = math.dist(segments[0][0], segments[-1][1]) if segments else 0.0
    return {"length_px": length, "direct_px": distance,
            "ratio": length/distance if distance > 0 else None,
            "limit_px": 1.3*distance+20, "bends": connector.bends}


def refline_runs(segments, reference_segments, source_circle=None):
    """Continuous display-path lengths in a finite reference line's 4 px band.

    Clip analytically in the reference's tangent/normal coordinates, then
    subtract only the identified source disc. Join adjacent qualifying pieces
    across elbows/flattened curves, never across an unqualified path interval
    or a jump between disconnected pieces.
    """
    runs, active, previous_end = [], False, None
    for start, end in segments:
        active = active and previous_end is not None and math.dist(previous_end, start) < _EPS
        dx, dy = end[0]-start[0], end[1]-start[1]
        length2 = dx*dx+dy*dy
        if length2 <= _EPS*_EPS:
            continue
        intervals = []
        for a, b in reference_segments:
            length = math.dist(a, b)
            if length <= _EPS:
                continue
            tx, ty = (b[0]-a[0])/length, (b[1]-a[1])/length
            u, v = (start[0]-a[0])*tx+(start[1]-a[1])*ty, -(start[0]-a[0])*ty+(start[1]-a[1])*tx
            du, dv = dx*tx+dy*ty, -dx*ty+dy*tx
            lo, hi = 0.0, 1.0
            for value, delta, low, high in ((u, du, 0, length), (v, dv, -REFLINE_BAND_PX, REFLINE_BAND_PX)):
                if abs(delta) < _EPS:
                    if value < low-_EPS or value > high+_EPS:
                        hi = -1
                        break
                else:
                    first, last = (low-value)/delta, (high-value)/delta
                    lo, hi = max(lo, min(first, last)), min(hi, max(first, last))
            if hi > lo:
                intervals.append((lo, hi))
        merged = []
        for lo, hi in sorted(intervals):
            if merged and lo <= merged[-1][1]+_EPS:
                merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
            else:
                merged.append((lo, hi))
        if source_circle is not None:
            cx, cy, radius = source_circle
            t = ((cx-start[0])*dx+(cy-start[1])*dy)/length2
            remaining = radius*radius-(cx-start[0]-t*dx)**2-(cy-start[1]-t*dy)**2
            if remaining > 0:
                half = math.sqrt(remaining/length2)
                low, high = t-half, t+half
                merged = [piece for lo, hi in merged
                          for piece in ((lo, min(hi, low)), (max(lo, high), hi)) if piece[1] > piece[0]]
        for lo, hi in merged:
            a, b = (start[0]+lo*dx, start[1]+lo*dy), (start[0]+hi*dx, start[1]+hi*dy)
            if active and runs and math.dist(runs[-1]['segments'][-1][1], a) < _EPS:
                runs[-1]['segments'].append((a, b))
                runs[-1]['run_px'] += math.dist(a, b)
            else:
                runs.append({'segments': [(a, b)], 'run_px': math.dist(a, b)})
            active = hi >= 1-_EPS
        active = bool(merged) and merged[-1][1] >= 1-_EPS
        previous_end = end
    return runs


def _lines_and_connectors(lines, annotations, axes_boxes, renderer):
    references, connectors = [], []
    for line in lines:
        ax = line.axes
        if ax not in axes_boxes:
            continue  # Tick and legend handles are not reference lines/leaders.
        points = line.get_transform().transform(line.get_xydata())
        if len(points) < 2:
            continue
        axbox = axes_boxes[ax]
        orientation = None
        if len(points) == 2 and all(_finite(point) for point in points):
            (x0, y0), (x1, y1) = points
            if abs(y0 - y1) < 0.5 and abs(x1 - x0) >= 0.9 * (axbox[2] - axbox[0]):
                orientation = "h"
            elif abs(x0 - x1) < 0.5 and abs(y1 - y0) >= 0.9 * (axbox[3] - axbox[1]):
                orientation = "v"
        clip = _clip_rect(line, axes_boxes)
        segments = []
        # get_path includes every drawn step/elbow; flatten curves in pixels.
        path = line.get_path().transformed(line.get_transform())
        for start, end in _path_segments(path):
            segment = _segment_in_rect(start, end, clip) if clip is not None else (start, end)
            if segment is not None:
                segments.append(segment)
        if orientation is not None and not getattr(line, "_fw_connector", False):
            references.append((line, orientation, segments))
        elif getattr(line, "_fw_connector", None) is not False:
            # Chart leaders are short Line2D paths. Ordinary series may opt out.
            source = line.get_transform().transform(getattr(line, "_fw_source_xy", line.get_xydata()[0]))
            connectors.append(Connector(getattr(line, "_fw_owner_text", None), segments, source,
                                        getattr(line, "_fw_source_disc", None), _path_bends(path), ax))
    for text in annotations:
        if text.arrow_patch is None:
            continue
        arrow = text.arrow_patch
        if not _visible(arrow):
            continue
        path = arrow.get_path().transformed(arrow.get_transform())
        clip = _clip_rect(arrow, axes_boxes)
        segments = []
        for start, end in _path_segments(path):
            segment = _segment_in_rect(start, end, clip) if clip is not None else (start, end)
            if segment is not None:
                segments.append(segment)
        connectors.append(Connector(text, segments, text._get_position_xy(renderer),
                                    getattr(text, "_fw_source_disc", None), _path_bends(path), text.axes))
    return references, connectors


def _opaque_above(text, line):
    patch = text.get_bbox_patch()
    return (patch is not None and _visible(patch) and patch.get_fill()
            and patch.get_facecolor()[3] >= 0.999
            and text.get_zorder() > line.get_zorder())


def _owns(owner, text):
    return owner is text or isinstance(owner, int) and owner == id(text)


def _source_disc(connector, discs):
    if not _finite(connector.source):
        return None
    # Explicit collection/offset identity disambiguates overlapping markers.
    # Its center must equal the source hint. Cluster membership is resolved
    # later and never repairs an invalid/ambiguous source identity.
    if connector.source_disc is not None:
        collection, index = connector.source_disc
        return next((disc for disc in discs if disc.collection is collection and disc.index == index
                     and math.dist(connector.source, (disc.cx, disc.cy)) < _EPS), None)
    # Ordinary annotate/Line2D has no identity hint: exempt at most the nearest
    # source-containing marker. Ambiguous coincident centers get no exemption.
    candidates = sorted((math.dist(connector.source, (disc.cx, disc.cy)), i, disc)
                        for i, disc in enumerate(discs)
                        if math.dist(connector.source, (disc.cx, disc.cy)) <= disc.radius)
    if not candidates or len(candidates) > 1 and abs(candidates[0][0]-candidates[1][0]) < _EPS:
        return None
    return candidates[0][2]


def audit(fig, connector_metrics=None):
    """Draw a figure and return all ten hard layout violations in pixels."""
    texts, collections, lines, annotations = _drawn_artists(fig)
    renderer = fig.canvas.get_renderer()
    axes_boxes = {ax: _rect(ax.get_window_extent(renderer)) for ax in fig.axes}
    figure_box = _rect(fig.bbox)
    roles, owners = _text_roles(fig)
    discs = _discs(collections, fig.dpi, axes_boxes)
    circles = [(d.cx, d.cy, d.radius) for d in discs]
    components = disc_clusters(circles)
    references, connectors = _lines_and_connectors(lines, annotations, axes_boxes, renderer)
    sources = [_source_disc(connector, discs) for connector in connectors]
    clusters = [next((components[i] for i, disc in enumerate(discs) if disc is source), None)
                for source in sources]
    issues = []

    for text, box in texts:
        name = text.get_text()
        if not _is_badge(text):
            for disc in discs:
                cx, cy, radius, clip = disc.cx, disc.cy, disc.radius, disc.clip
                drawn_box = _intersection(box, clip) if clip is not None else box
                if drawn_box is None:
                    continue
                depth = _rect_circle_depth(drawn_box, cx, cy, radius)
                if depth > BUBBLE_TOLERANCE_PX:
                    issues.append({"type": "text_bubble", "text": name, "box": _pixels(box),
                                   "bubble": _pixels((cx, cy, radius)), "depth_px": round(depth, 2)})
        for line, orientation, segments in references:
            if _opaque_above(text, line):
                continue
            for start, end in segments:
                crossing = _segment_in_rect(start, end, box)
                # A line on the border does not pass through the glyph box.
                if crossing is None:
                    continue
                if orientation == "h" and not box[1] + _EPS < start[1] < box[3] - _EPS:
                    continue
                if orientation == "v" and not box[0] + _EPS < start[0] < box[2] - _EPS:
                    continue
                overlap = math.dist(*crossing)
                if overlap > _EPS:
                    issues.append({"type": "text_refline", "text": name, "box": _pixels(box),
                                   "line": orientation, "segment": [_pixels(start), _pixels(end)],
                                   "overlap_px": round(overlap, 2)})
                    break
        role = roles.get(id(text), "annotation" if isinstance(text, Annotation) else "text")
        ax = owners.get(id(text), text.axes)
        constrained = getattr(text, "_fw_label", role in ("text", "annotation", "badge") and ax is not None)
        if constrained and ax in axes_boxes:
            axbox = axes_boxes[ax]
            spills = (max(0.0, axbox[0] - box[0]), max(0.0, axbox[1] - box[1]),
                      max(0.0, box[2] - axbox[2]), max(0.0, box[3] - axbox[3]))
            if max(spills) > _EPS:
                issues.append({"type": "text_outside", "text": name, "box": _pixels(box),
                               "axes_box": _pixels(axbox), "spill_px": round(max(spills), 2)})
        spills = (max(0.0, figure_box[0] - box[0]), max(0.0, figure_box[1] - box[1]),
                  max(0.0, box[2] - figure_box[2]), max(0.0, box[3] - figure_box[3]))
        if max(spills) > _EPS:
            issues.append({"type": "text_clipped", "text": name, "box": _pixels(box),
                           "figure_box": _pixels(figure_box), "spill_px": round(max(spills), 2)})

    for index, (first, first_box) in enumerate(texts):
        for second, second_box in texts[index + 1:]:
            # Same-axes ticks are exempt; different subplot ticks must be checked.
            if (roles.get(id(first)) == roles.get(id(second)) == "tick"
                    and owners.get(id(first)) is owners.get(id(second))):
                continue
            xgap = max(first_box[0] - second_box[2], second_box[0] - first_box[2], 0.0)
            ygap = max(first_box[1] - second_box[3], second_box[1] - first_box[3], 0.0)
            gap = math.hypot(xgap, ygap)
            if gap < TEXT_GAP_PX:
                overlap = (max(0.0, min(first_box[2], second_box[2]) - max(first_box[0], second_box[0])),
                           max(0.0, min(first_box[3], second_box[3]) - max(first_box[1], second_box[1])))
                union = (min(first_box[0], second_box[0]), min(first_box[1], second_box[1]),
                         max(first_box[2], second_box[2]), max(first_box[3], second_box[3]))
                issues.append({"type": "text_text", "text": first.get_text(), "other_text": second.get_text(),
                               "a": first.get_text(), "b": second.get_text(), "box": _pixels(union),
                               "a_box": _pixels(first_box), "b_box": _pixels(second_box),
                               "gap_px": round(gap, 2), "overlap_px": _pixels(overlap)})

    for index, connector in enumerate(connectors):
        owner, segments = connector.owner, connector.segments
        geometry = connector_geometry(connector)
        checked = getattr(fig, "_fw_chart_kind", None) in DETOUR_KINDS
        source = sources[index]
        source_circle = (source.cx, source.cy, source.radius) if source is not None else None
        max_run = 0.0
        for line, orientation, reference_segments in references:
            if line.axes is not connector.axes:
                continue
            for run in refline_runs(segments, reference_segments, source_circle):
                max_run = max(max_run, run['run_px'])
                if run['run_px'] > REFLINE_RUN_PX+_EPS:
                    vertices = [p for pair in run['segments'] for p in pair]
                    issues.append({'type': 'connector_refline',
                                   'owner_text': owner.get_text() if isinstance(owner, Text) else None,
                                   'line': orientation, 'run_px': round(run['run_px'], 2),
                                   'box': _pixels((min(p[0] for p in vertices)-REFLINE_BAND_PX,
                                                   min(p[1] for p in vertices)-REFLINE_BAND_PX,
                                                   max(p[0] for p in vertices)+REFLINE_BAND_PX,
                                                   max(p[1] for p in vertices)+REFLINE_BAND_PX))})
        if connector_metrics is not None:
            connector_metrics.append({"owner_text": owner.get_text() if isinstance(owner, Text) else None,
                                      **geometry, "checked": checked, "refline_max_run_px": max_run,
                                      "endpoints": [_pixels(segments[0][0]), _pixels(segments[-1][1])] if segments else []})
        if checked and (geometry["length_px"] > geometry["limit_px"] or connector.bends > 2):
            vertices = [point for segment in segments for point in segment]
            issues.append({"type": "connector_detour", **geometry,
                           "owner_text": owner.get_text() if isinstance(owner, Text) else None,
                           "box": _pixels((min(p[0] for p in vertices), min(p[1] for p in vertices),
                                           max(p[0] for p in vertices), max(p[1] for p in vertices))) if vertices else None})
        for text, box in texts:
            if _owns(owner, text):
                continue
            inside = (box[0] + _EPS, box[1] + _EPS, box[2] - _EPS, box[3] - _EPS)
            for start, end in segments:
                crossing = _segment_in_rect(start, end, inside)
                if crossing is not None and math.dist(*crossing) > _EPS:
                    issues.append({"type": "connector_text", "text": text.get_text(), "box": _pixels(box),
                                   "owner_text": owner.get_text() if isinstance(owner, Text) else None,
                                   "segment": [_pixels(start), _pixels(end)],
                                   "overlap_px": round(math.dist(*crossing), 2)})
                    break
        for disc_index, disc in enumerate(discs):
            if clusters[index] is not None and components[disc_index] == clusters[index]:
                continue
            for start, end in segments:
                visible_segment = _segment_in_rect(start, end, disc.clip) if disc.clip is not None else (start, end)
                if visible_segment is None:
                    continue
                distance = point_segment_distance((disc.cx, disc.cy), *visible_segment)
                depth = disc.radius - distance
                if distance < disc.radius + CONNECTOR_BUBBLE_GAP_PX:
                    issues.append({"type": "connector_bubble", "owner_text": owner.get_text() if isinstance(owner, Text) else None,
                                   "bubble": _pixels((disc.cx, disc.cy, disc.radius)),
                                   "box": _pixels((disc.cx-disc.radius, disc.cy-disc.radius, disc.cx+disc.radius, disc.cy+disc.radius)),
                                   "segment": [_pixels(start), _pixels(end)], "depth_px": round(depth, 2),
                                   "gap_px": round(-depth, 2), "required_gap_px": CONNECTOR_BUBBLE_GAP_PX})
                    break
    for index, first in enumerate(connectors):
        for other_index in range(index+1, len(connectors)):
            second = connectors[other_index]
            shared_cluster = [circle for i, circle in enumerate(circles) if components[i] == clusters[index]] if (
                clusters[index] is not None and clusters[index] == clusters[other_index]) else []
            crossing = connector_crossing(first.segments, second.segments, shared_cluster)
            if crossing is not None:
                a, b, c, d, points = crossing
                issues.append({"type": "connector_crossing",
                               "owner_text": first.owner.get_text() if isinstance(first.owner, Text) else None,
                               "other_owner_text": second.owner.get_text() if isinstance(second.owner, Text) else None,
                               "segment": [_pixels(a), _pixels(b)], "other_segment": [_pixels(c), _pixels(d)],
                               "intersection": [_pixels(point) for point in points],
                               "box": _pixels((min(p[0] for p in points)-4, min(p[1] for p in points)-4,
                                               max(p[0] for p in points)+4, max(p[1] for p in points)+4))})
    return issues


def mark_issues(fig, issues):
    """Add red display-pixel rectangles to a rejected figure before saving."""
    marked = set()
    for issue in issues:
        for key in ("box", "a_box", "b_box"):
            box = issue.get(key)
            if box is None or len(box) != 4 or not _finite(box):
                continue
            box = tuple(box)
            if box in marked:
                continue
            marked.add(box)
            rectangle = Rectangle((box[0], box[1]), box[2] - box[0], box[3] - box[1],
                                  transform=IdentityTransform(), fill=False, edgecolor="#e02020",
                                  linewidth=1.5, zorder=10000, clip_on=False)
            rectangle._fw_audit_mark = True
            fig.add_artist(rectangle)
    return fig
