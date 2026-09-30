"""Measured deterministic label columns and obstacle-aware connector geometry."""
import math
from itertools import combinations, islice

from matplotlib import pyplot as plt
from matplotlib.ticker import FixedLocator, MaxNLocator

from audit import (CONNECTOR_BUBBLE_GAP_PX, REFLINE_RUN_PX, connector_crossing,
                   disc_clusters, point_segment_distance, refline_runs)
from style import COLORS, MARKERS, DPI, axes_style, measure, number


def hit_segment(a, b, box):
    # Slab intersection: only actual interior crossing is forbidden.
    lo, hi = 0.0, 1.0
    for idx in (0, 1):
        start, delta = a[idx], b[idx] - a[idx]
        if abs(delta) < 1e-9:
            if not box[idx] < start < box[idx + 2]:
                return False
        else:
            t1, t2 = (box[idx] - start) / delta, (box[idx + 2] - start) / delta
            lo, hi = max(lo, min(t1, t2)), min(hi, max(t1, t2))
            if lo >= hi - 1e-8:
                return False
    return hi > 0 and lo < 1


def connector_route(start, end, boxes, bounds):
    """Short direct/single-elbow leaders for narrow price-band labels."""
    obstacles = [(b[0]-5, b[1]-5, b[2]+5, b[3]+5) for b in boxes]
    for route in ([start, end], [start, (start[0], end[1]), end],
                  [start, (end[0], start[1]), end]):
        if all(not any(hit_segment(a, b, box) for box in obstacles)
               for a, b in zip(route, route[1:])):
            return route
    # Keep an invalid candidate visible to the hard gate.
    return [start, end]


def badge_labels(fig, ax, points, areas, colors):
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inverse = ax.transData.inverted()
    placed, badges = [], []
    bounds = ax.get_window_extent(renderer)
    for i, (point, area) in enumerate(zip(points, areas)):
        cx, cy = ax.transData.transform((number(point["x"]), number(point["y"])))
        radius = math.sqrt(area) / 2 * DPI / 72
        width, height = measure(fig, point["rank_label"], 8.2)
        offsets = [(0, 0)]
        # Number badges stay on the bubble disc. No coordinate/value is changed.
        for fraction in (.3, .55, .72):
            for angle in (0, 90, 180, 270, 45, 135, 225, 315, 22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5):
                radians = math.radians(angle)
                offsets.append((math.cos(radians) * radius * fraction, math.sin(radians) * radius * fraction))
        choice = (cx, cy)
        for dx, dy in offsets:
            px, py = cx + dx, cy + dy
            box = (px - width/2, py - height/2, px + width/2, py + height/2)
            if not (bounds.x0 + 3 < box[0] and box[2] < bounds.x1 - 3 and bounds.y0 + 3 < box[1] and box[3] < bounds.y1 - 3):
                continue
            if all(box[2] + 3 <= b[0] or box[0] >= b[2] + 3 or box[3] + 3 <= b[1] or box[1] >= b[3] + 3 for b in placed):
                choice = (px, py)
                break
        px, py = choice
        xy = inverse.transform(choice)
        artist = ax.text(*xy, point["rank_label"], fontsize=8.2, ha="center", va="center", color="white",
                         bbox={"boxstyle": "circle,pad=0.20", "facecolor": colors[i], "edgecolor": "white", "alpha": 1, "linewidth": .7}, zorder=6)
        artist._fw_badge = True
        badges.append(artist)
        placed.append((px-width/2, py-height/2, px+width/2, py+height/2))
    return badges



def separated(a, b, gap=4):
    return a[2]+gap <= b[0] or b[2]+gap <= a[0] or a[3]+gap <= b[1] or b[3]+gap <= a[1]


def fits_label(box, bounds, discs, boxes):
    if not (bounds[0]+6 <= box[0] and box[2] <= bounds[2]-6
            and bounds[1]+6 <= box[1] and box[3] <= bounds[3]-6):
        return False
    for cx, cy, radius in discs:
        near = (min(max(cx, box[0]), box[2]), min(max(cy, box[1]), box[3]))
        if math.dist((cx, cy), near) < radius+4:
            return False
    return all(separated(box, other) for other in boxes)


def nearby_boxes(cx, cy, radius, width, height):
    """Right, left, above, below, then NE/NW/SE/SW. No random adjustment."""
    distance = radius+10
    yield (cx+distance, cy-height/2, cx+distance+width, cy+height/2)
    yield (cx-distance-width, cy-height/2, cx-distance, cy+height/2)
    yield (cx-width/2, cy+distance, cx+width/2, cy+distance+height)
    yield (cx-width/2, cy-distance-height, cx+width/2, cy-distance)
    offset = distance/math.sqrt(2)
    for sx, sy in ((1,1), (-1,1), (1,-1), (-1,-1)):
        x = cx+sx*offset-(width if sx < 0 else 0)
        y = cy+sy*offset-(height if sy < 0 else 0)
        yield (x, y, x+width, y+height)


def column_centers(order, metrics, centers, bounds):
    """Fit measured heights with isotonic packing around the source y positions.

    Pool adjacent violations rather than pushing a whole dense cluster below
    its bubbles. This preserves source order while minimizing displacement.
    """
    if sum(metrics[i][1] for i in order)+14*max(0, len(order)-1) > bounds[3]-bounds[1]-32:
        return None
    if not order:
        return {}
    offsets, blocks = [0.0], []
    for index, i in enumerate(order):
        if index:
            offsets.append(offsets[-1]+(metrics[order[index-1]][1]+metrics[i][1])/2+14)
        blocks.append(([index], centers[i][1]+offsets[-1]))
        while len(blocks) > 1 and blocks[-2][1] < blocks[-1][1]:
            indices, value = blocks.pop()
            before, previous = blocks.pop()
            blocks.append((before+indices, (len(before)*previous+len(indices)*value)/(len(before)+len(indices))))
    low = bounds[1]+16+metrics[order[-1]][1]/2+offsets[-1]
    high = bounds[3]-16-metrics[order[0]][1]/2
    return {order[index]: min(high, max(low, value))-offsets[index]
            for indices, value in blocks for index in indices}


def leader_route(center, radius, target, boxes, discs, previous, bounds, references=()):
    """Only direct or single-elbow leaders, with the R1/R2 cluster exemptions.

    Failure is a label-placement failure; there is no visibility graph and no
    perimeter waypoint search. The caller must move labels or expand the figure.
    """
    angle = math.atan2(target[1]-center[1], target[0]-center[0])
    obstacles = [(b[0]-5, b[1]-5, b[2]+5, b[3]+5) for b in boxes]
    for offset in (0, 15, -15, 30, -30, 45, -45, 60, -60):
        theta = angle+math.radians(offset)
        start = (center[0]+(radius+4)*math.cos(theta), center[1]+(radius+4)*math.sin(theta))
        elbow = (target[0]+(12 if target[0] < center[0] else -12), target[1])
        for route in ([start, target], [start, elbow, target]):
            segments = list(zip(route, route[1:]))
            if sum(math.dist(a, b) for a, b in segments) > 1.3*math.dist(start, target)+20:
                continue
            if any(not (bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3]) for x, y in route):
                continue
            if any(any(hit_segment(a, b, box) for box in obstacles)
                   or any(point_segment_distance((cx, cy), a, b) < r+CONNECTOR_BUBBLE_GAP_PX for cx, cy, r in discs)
                   for a, b in segments):
                continue
            if any(connector_crossing(segments, other, shared) is not None
                   for other, shared in previous):
                continue
            if any(run['run_px'] > REFLINE_RUN_PX+1e-6 for reference in references
                   for run in refline_runs(segments, reference, (*center, radius))):
                continue
            return route
    return None


def bubble_panel(fig, ax, points, kind, attempt=0, title=None, reference=None, ylimits=None):
    """Measured two-sided brand columns; category labels prefer bubble neighbours."""
    fontsize = 9.8 if kind == 'brand_bubble' else (9.1 if kind == 'segment_matrix' else 10.2)
    metrics = [measure(fig, point['label'], fontsize) for point in points]
    xs, ys = [number(p['x']) for p in points], [number(p['y']) for p in points]
    data_min, data_max = min(xs+[0]), max(xs+[1])
    middle = (data_min+data_max)/2
    sides = ['left' if x <= middle else 'right' for x in xs]
    # Both columns must accommodate a label changing sides without changing
    # data coordinates mid-search. Width comes from real glyph extents.
    widths = dict.fromkeys(('left', 'right'), max([m[0] for m in metrics]+[80]))
    colors = [COLORS[p.get('segment_index', i) % 10] for i, p in enumerate(points)]
    if kind == 'brand_bubble':
        sizes = [number(p['size']) for p in points]
        low, high = min(sizes), max(sizes)
        # Preserve diameter-linear geometry, tab10 and rank badges from task E.
        areas = [(56 if low == high else 32+(s-low)/(high-low)*48)**2 for s in sizes]
    elif kind == 'category_bubble':
        sizes = [number(p['size']) for p in points]
        maximum = max(sizes+[1])
        areas = [max(90, s/maximum*4000) for s in sizes]
    else:
        areas = [150]*len(points)
    radii = [math.sqrt(area)/2*fig.dpi/72 for area in areas]
    maxradius = max(radii+[16])
    fig.canvas.draw()
    bbox = ax.get_window_extent(fig.canvas.get_renderer())
    bounds = tuple(bbox.extents)
    leftspace, rightspace = widths['left']+36, widths['right']+36
    dataleft, dataright = bbox.x0+leftspace+maxradius+10, bbox.x1-rightspace-maxradius-10
    if dataright-dataleft < 100:
        return False
    scale = max(data_max-data_min, 1)/(dataright-dataleft)
    ax.set_xlim(data_min-(dataleft-bbox.x0)*scale, data_max+(bbox.x1-dataright)*scale)
    bottom, top = min(ys+[0]), max(ys+[0])
    span = max(top-bottom, 1)
    ax.set_ylim(*(ylimits if ylimits is not None else (bottom-span*.20, top+span*.20)))
    axes_style(ax, 'share' if kind == 'brand_bubble' else 'money', 'pp' if kind == 'brand_bubble' else 'percent')
    ticks = MaxNLocator(nbins=3 if kind == 'segment_matrix' else 5).tick_values(data_min, data_max)
    ax.xaxis.set_major_locator(FixedLocator([v for v in ticks if data_min <= v <= data_max]))
    ax.set_xlabel('当期金额份额（%）' if kind == 'brand_bubble' else '当期销售额（CNY）', fontsize=10, labelpad=10)
    ax.set_ylabel('金额份额同比变化（pp）' if kind == 'brand_bubble' else '金额同比（%）', fontsize=10, labelpad=10)
    if title:
        ax.set_title(title, fontsize=13, pad=14, color='#555555')
    ax.axhline(0, color='#D62728' if kind == 'brand_bubble' else '#B8B8B8', linestyle='--', linewidth=1.2, zorder=1)
    if reference:
        ax.axvline(number(reference['median']['value']), color='#999999', linestyle='--', linewidth=1, zorder=1)
        ax.axhline(number(reference['growth']['value']), color='#888888', linestyle='--', linewidth=1, zorder=1)
    collections = []
    for p, area, color in zip(points, areas, colors):
        collections.append(ax.scatter(number(p['x']), number(p['y']), s=area,
                           marker=MARKERS[p['segment_index'] % len(MARKERS)] if kind == 'segment_matrix' else 'o',
                           color=color, alpha=.58 if kind == 'brand_bubble' else .78, edgecolor='white', linewidth=1.3, zorder=2))
    badges = badge_labels(fig, ax, points, areas, colors) if kind == 'brand_bubble' else []
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inverse = ax.transData.inverted()
    references = [[tuple(tuple(p) for p in line.get_transform().transform(line.get_xydata()))]
                  for line in ax.lines]
    centers = [tuple(ax.transData.transform((x, y))) for x, y in zip(xs, ys)]
    discs = [(center[0], center[1], radius) for center, radius in zip(centers, radii)]
    texts = [None]*len(points)
    occupied = [tuple(t.get_window_extent(renderer).extents) for t in badges]

    def label(i, x, y, ha, column=None):
        text = ax.text(*inverse.transform((x, y)), points[i]['label'], fontsize=fontsize, ha=ha, va='center', color='#222222',
                       linespacing=1.35, bbox={'facecolor': 'white', 'edgecolor': 'none', 'alpha': 1, 'pad': 2}, zorder=5)
        text._fw_label = True
        text._fw_point_index = i
        text._fw_label_column = column
        texts[i] = text
        occupied.append(tuple(text.get_window_extent(renderer).extents))

    if kind == 'category_bubble':
        for i, ((cx, cy), radius, (width, height)) in enumerate(zip(centers, radii, metrics)):
            for box in nearby_boxes(cx, cy, radius, width, height):
                if fits_label(box, bounds, discs, occupied):
                    label(i, box[0], (box[1]+box[3])/2, 'left')
                    break
    pending = [i for i, text in enumerate(texts) if text is None]
    badgeboxes = [tuple(t.get_window_extent(renderer).extents) for t in badges]
    components = disc_clusters(discs)
    fixed = {i: tuple(t.get_window_extent(renderer).extents) for i, t in enumerate(texts) if t is not None}
    route_order = sorted(pending, key=lambda i: (-ys[i], i), reverse=bool(attempt % 2))

    def placement(candidate, shifted=(), direction=0, scale=1):
        textboxes, positions = dict(fixed), {}
        for side in ('left', 'right'):
            order = sorted([i for i in pending if candidate[i] == side], key=lambda i: (-ys[i], i))
            x = bbox.x0+18+widths['left'] if side == 'left' else bbox.x1-18-widths['right']
            # When a direct leader skims a reference, move its preferred slot
            # by enough for a 15 degree departure, then repack the whole column
            # in source order. Only label geometry changes, never data values.
            preferred = list(centers)
            targetx = x+8 if side == 'left' else x-8
            for i in shifted:
                distance = max(52, abs(targetx-centers[i][0])*math.tan(math.radians(15)))
                preferred[i] = (centers[i][0], centers[i][1]+direction*scale*distance)
            slots = column_centers(order, metrics, preferred, bounds)
            if slots is None:
                return None
            for i in order:
                width, height = metrics[i]
                y = slots[i]
                positions[i] = (x, y, 'right' if side == 'left' else 'left', side)
                textboxes[i] = (x-width if side == 'left' else x, y-height/2,
                                x if side == 'left' else x+width, y+height/2)
        previous, routes, failed, refblocked = [], {}, [], []
        for i in route_order:
            box = textboxes[i]
            target = (box[2]+8 if candidate[i] == 'left' else box[0]-8, (box[1]+box[3])/2)
            boxes = [b for j, b in textboxes.items() if i != j]
            boxes.extend(b for j, b in enumerate(badgeboxes) if i != j)
            cluster = [disc for j, disc in enumerate(discs) if components[j] == components[i]]
            foreign = [disc for j, disc in enumerate(discs) if components[j] != components[i]]
            earlier = [(segments, cluster if components[j] == components[i] else ()) for j, segments in previous]
            route = leader_route(centers[i], radii[i], target, boxes, foreign, earlier, bounds, references)
            if route is None:
                failed.append(i)
                if leader_route(centers[i], radii[i], target, boxes, foreign, earlier, bounds) is not None:
                    refblocked.append(i)
                angle = math.atan2(target[1]-centers[i][1], target[0]-centers[i][0])
                start = (centers[i][0]+(radii[i]+4)*math.cos(angle), centers[i][1]+(radii[i]+4)*math.sin(angle))
                route = [start, target]
            routes[i] = route
            previous.append((i, list(zip(route, route[1:]))))
        return positions, routes, failed, refblocked

    def fit_placement(candidate):
        best = placement(candidate)
        if best is None or not best[3]:
            return best
        shifted = best[3]
        # A small, ordered slot search; connectors keep the same direct / one
        # elbow candidates. Height retries handle genuinely crowded columns.
        for scale in (1, 1.5, 2):
            for direction in (1, -1):
                result = placement(candidate, shifted, direction, scale)
                if result is not None and len(result[2]) < len(best[2]):
                    best = result
                if result is not None and not result[2]:
                    return result
        return best

    best = fit_placement(sides)
    placements = 1
    if best is None or best[2]:
        # Change label columns, in increasing number of moves from the near
        # side assignment. Repack every column after a move. Bounded search
        # also makes extreme synthetic input fail cleanly instead of hanging.
        blocked = set(best[2] if best is not None else pending)
        move_order = sorted(pending, key=lambda i: (i not in blocked, i))
        candidates = (moves for count in range(1, len(pending)+1) for moves in combinations(move_order, count))
        for moves in islice(candidates, 511):
            candidate = list(sides)
            for i in moves:
                candidate[i] = 'right' if sides[i] == 'left' else 'left'
            result = fit_placement(candidate)
            placements += 1
            if result is not None and (best is None or len(result[2]) < len(best[2])):
                best = result
            if result is not None and not result[2]:
                best = result
                break
    fig._fw_label_placements = getattr(fig, '_fw_label_placements', 0)+placements
    if best is None:
        return False
    positions, routes, failed, _ = best
    for i in pending:
        label(i, *positions[i])
    for i in route_order:
        route = routes[i]
        data = inverse.transform(route)
        line, = ax.plot(data[:, 0], data[:, 1], color=colors[i], lw=.8, alpha=.68, zorder=3)
        line._fw_connector = True
        line._fw_owner_text = texts[i]
        line._fw_source_xy = (xs[i], ys[i])
        line._fw_source_disc = (collections[i], 0)
    return not failed
