"""Strict equivalent of a closed JSON Schema. Unknown fields never get guessed."""
import math

COMMON = {"id", "kind", "file", "before_table", "evidence", "title", "subtitle", "caption", "status", "excluded", "notes"}
EXTRAS = {
    "category_bubble": {"points", "reference"},
    "segment_matrix": {"segments", "panels", "layout"},
    "price_band": {"bands", "ranges"},
    "brand_bubble": {"points", "currency"},
}


def obj(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - (set(required) | set(optional)) or set(required) - set(value):
        raise ValueError(f"invalid object fields: expected {sorted(required)}, got {sorted(value) if isinstance(value, dict) else type(value).__name__}")


def text(value):
    if not isinstance(value, str):
        raise ValueError("expected string")


def sequence(value):
    if not isinstance(value, list):
        raise ValueError("expected array")
    return value


def num(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)) or not math.isfinite(float(value)):
        raise ValueError("invalid geometry decimal")


def points(value, fields):
    for p in sequence(value):
        obj(p, fields)
        for key in ("name", "label"):
            text(p[key])
        for key in ("x", "y", "size"):
            if key in fields:
                num(p[key])
        if "rank" in fields:
            num(p["rank"])
            text(p["rank_label"])
            if not isinstance(p["pinned"], bool):
                raise ValueError("expected pinned boolean")
        if "segment_index" in fields and (type(p["segment_index"]) is not int or p["segment_index"] < 0):
            raise ValueError("invalid segment_index")


def validate(root):
    obj(root, {"version", "label", "release_id", "windows", "charts"})
    if root["version"] != 1:
        raise ValueError("unknown chart specification version")
    text(root["label"])
    text(root["release_id"])
    # Window metadata is closed too; no unknown dates/flags are silently guessed.
    obj(root["windows"], {"current"}, {"yoy", "prior_period"})
    for key, window in root["windows"].items():
        if window is None and key != "current":
            continue
        obj(window, {"start", "end"}, {"months", "status"})
        text(window["start"])
        text(window["end"])
        if "months" in window:
            for month in sequence(window["months"]):
                text(month)
        if "status" in window:
            text(window["status"])
    seen = set()
    for s in sequence(root["charts"]):
        kind = s.get("kind") if isinstance(s, dict) else None
        if kind not in EXTRAS:
            raise ValueError("unknown chart kind")
        obj(s, COMMON | (EXTRAS[kind] if s.get("status") == "ready" else set()), {"reason"})
        for key in ("id", "kind", "file", "before_table", "title", "subtitle", "caption"):
            text(s[key])
        if s["id"] in seen or "/" in s["file"] or "\\" in s["file"] or not s["file"].endswith(".png"):
            raise ValueError("duplicate id or unsafe image filename")
        seen.add(s["id"])
        if s["status"] not in ("ready", "skipped"):
            raise ValueError("unknown chart status")
        if "reason" in s:
            text(s["reason"])
        for key in ("evidence", "notes"):
            for item in sequence(s[key]):
                text(item)
        for item in sequence(s["excluded"]):
            obj(item, {"name", "status", "reason"})
            for value in item.values():
                text(value)
        if s["status"] == "skipped":
            continue
        if kind == "category_bubble":
            points(s["points"], {"name", "x", "y", "size", "label"})
            obj(s["reference"], {"median", "growth"})
            for ref in s["reference"].values():
                obj(ref, {"value", "label"})
                num(ref["value"])
                text(ref["label"])
        elif kind == "brand_bubble":
            points(s["points"], {"name", "x", "y", "size", "rank", "rank_label", "label", "pinned"})
            # Non-brand buckets must never enter a brand chart, even if a caller
            # bypasses the evidence-to-spec compiler. Exact matching preserves
            # real slash-containing brands such as EUROTHERM/欧陆.
            if any(point["name"] in ("OTHERS/其他", "未分类") for point in s["points"]):
                raise ValueError("non-brand bucket in brand chart")
            text(s["currency"])
        elif kind == "segment_matrix":
            if s["layout"] not in ("row", "grid"):
                raise ValueError("invalid matrix layout")
            for name in sequence(s["segments"]):
                text(name)
            for panel in sequence(s["panels"]):
                obj(panel, {"site", "name", "points"})
                text(panel["site"])
                text(panel["name"])
                points(panel["points"], {"name", "x", "y", "label", "segment_index"})
                if any(p["segment_index"] >= len(s["segments"]) for p in panel["points"]):
                    raise ValueError("segment index outside legend")
        elif kind == "price_band":
            for band in sequence(s["bands"]):
                obj(band, {"name"})
                text(band["name"])
            policy_names = [band["name"] for band in s["bands"]]
            if len(set(policy_names)) != len(policy_names):
                raise ValueError("duplicate policy band")
            for scope in sequence(s["ranges"]):
                obj(scope, {"site", "name", "bands", "asp_label"})
                for key in ("site", "name", "asp_label"):
                    text(scope[key])
                for band in sequence(scope["bands"]):
                    obj(band, {"name", "current", "yoy", "current_label", "yoy_label", "growth_label"})
                    for key in ("current", "yoy"):
                        num(band[key])
                    for key in ("name", "current_label", "yoy_label", "growth_label"):
                        text(band[key])
                scope_names = [band["name"] for band in scope["bands"]]
                if len(set(scope_names)) != len(scope_names) or not set(scope_names) <= set(policy_names):
                    raise ValueError("unknown or duplicate policy band")
    return root
