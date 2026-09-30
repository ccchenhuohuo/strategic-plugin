#!/usr/bin/env python3
"""Render evidence-only chart specifications; failed layout is a rejected image."""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ["MPLBACKEND"] = "Agg"

from matplotlib import pyplot as plt
import brand_bubble
import category_bubble
import price_band
import segment_matrix
from audit import audit, mark_issues
from schema import validate
from style import save_png, setup_font

MODULES = {"category_bubble": category_bubble, "brand_bubble": brand_bubble,
           "segment_matrix": segment_matrix, "price_band": price_band}


def write_audit(out, records):
    (out / "audit.json").write_text(json.dumps({"version": 1, "charts": records}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--specs", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    root = validate(json.loads(Path(args.specs).read_text(encoding="utf-8")))
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    records = []
    font = setup_font()
    if font is None:
        for spec in root["charts"]:
            records.append({"id": spec["id"], "kind": spec["kind"], "file": spec["file"], "status": "skipped", "reason": "缺少中文字体", "audit": {"issues": [], "layout": "none", "attempts": 0}})
        write_audit(out, records)
        return 2
    for spec in root["charts"]:
        record = {"id":spec["id"], "kind":spec["kind"], "file":spec["file"]}
        if spec["status"] == "skipped":
            record.update(status="skipped", reason=spec.get("reason", "数据不可用"), audit={"issues":[],"layout":"none","attempts":0})
            records.append(record)
            continue
        module = MODULES[spec["kind"]]
        try:
            for attempt, layout in enumerate(module.LAYOUTS):
                fig, capacity_issues = module.render(spec, attempt)
                connectors = []
                issues = capacity_issues + audit(fig, connectors)
                record["audit"] = {"issues":issues, "layout":layout, "attempts":attempt+1,
                                   "connectors":connectors,
                                   "canvas_px": [int(v) for v in fig.bbox.size],
                                   **({"panel_layout": fig._fw_panel_layout} if hasattr(fig, "_fw_panel_layout") else {}),
                                   "label_placements":getattr(fig, "_fw_label_placements", 0)}
                if not issues:
                    save_png(fig, out / spec["file"])
                    record["status"] = "ok"
                    plt.close(fig)
                    break
                if attempt == len(module.LAYOUTS)-1:
                    (out / "rejected").mkdir(exist_ok=True)
                    mark_issues(fig, issues)
                    save_png(fig, out / "rejected" / spec["file"])
                    record.update(status="rejected", reason="全部确定性布局策略均未通过版面检测")
                plt.close(fig)
        except Exception as error:
            plt.close("all")
            record.update(status="failed", reason=f"{type(error).__name__}: {error}", audit={"issues":[],"layout":"none","attempts":0})
        records.append(record)
        print(f"{spec['id']}: {record['status']}", file=sys.stderr)
    write_audit(out, records)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"chart renderer: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
