#!/usr/bin/env python3
"""Build the visualizer page for one Mossbear audio artifact.

    build.py --track <audio id> [--lyrics <note id>] [--timing timing.json]
             --title "<song>" [--subtitle "<artist · where/when>"] --out page.html

The page reads the track (and the lyrics note) from Mossbear when it opens;
it holds no audio and no words. --timing is align.py's output: when each
lyric line starts in this recording, tied to the note it was made from.
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TEMPLATE = Path(__file__).with_name("template.html")


def die(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def artifact_id(value, flag):
    """Accept a bare id or an artifact link."""
    value = value.strip().rstrip("/")
    m = re.search(r"/artifact/([A-Za-z0-9_-]+)", value)
    value = m.group(1) if m else value
    if not ID.match(value):
        die(f"{flag} is not an artifact id or link: {value!r}")
    return value


def script_json(value):
    """JSON safe inside a <script> element."""
    return json.dumps(value, ensure_ascii=False, indent=1).replace("<", "\\u003c")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", required=True, help="The audio artifact's id or link")
    ap.add_argument("--lyrics", help="The lyrics note's id or link")
    ap.add_argument("--timing", help="timing.json from align.py")
    ap.add_argument("--title", required=True)
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    track = artifact_id(args.track, "--track")
    reads = {"track": {"artifact": track, "want": "audio"}}
    timing = None
    if args.lyrics:
        reads["lyrics"] = {"artifact": artifact_id(args.lyrics, "--lyrics"), "want": "text"}
    if args.timing:
        if not args.lyrics:
            die("--timing needs --lyrics: the timing belongs to a lyrics note")
        raw = json.loads(Path(args.timing).read_text())
        times = raw.get("times")
        if not isinstance(raw.get("fingerprint"), str) or not isinstance(times, list) or not all(
                t is None or (isinstance(t, (int, float)) and t >= 0) for t in times):
            die("--timing is not align.py's timing.json")
        timing = {"fingerprint": raw["fingerprint"], "times": [None if t is None else round(float(t), 2) for t in times]}

    title, subtitle = args.title.strip(), args.subtitle.strip()
    if not title:
        die("--title is empty")
    config = {"title": title, "subtitle": subtitle, "track": track, "timing": timing}
    declaration = {"runtime": 1, "reads": reads}

    page = TEMPLATE.read_text(encoding="utf-8")
    page_title = f"{title} · {subtitle}" if subtitle else title
    page = page.replace("<title>{{TITLE}}</title>", f"<title>{html.escape(page_title)}</title>")
    for key, value in (("{{DECLARATION}}", script_json(declaration)), ("{{CONFIG}}", script_json(config)),
                       ("{{TITLE}}", html.escape(title)), ("{{SUBTITLE}}", html.escape(subtitle))):
        if key not in page:
            die(f"template.html has no {key}")
        page = page.replace(key, value)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(json.dumps({
        "ok": True, "page": str(out), "bytes": len(page.encode("utf-8")),
        "reads": reads, "timedLines": None if not timing else sum(t is not None for t in timing["times"]),
    }, indent=1))


if __name__ == "__main__":
    main()
