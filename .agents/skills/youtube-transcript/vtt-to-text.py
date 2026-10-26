#!/usr/bin/env python3
"""Flatten a WebVTT subtitle file into readable prose.

YouTube auto-captions are a rolling window: each cue repeats the tail of the
previous one, so a naive strip yields every phrase two or three times. This
de-duplicates against the running tail rather than against whole lines, which
is what makes the output readable.

Usage: vtt-to-text.py <file.vtt> [--keep-timestamps]
"""

import re
import sys

TAG = re.compile(r"<[^>]+>")
CUE = re.compile(r"^\d\d:\d\d:\d\d\.\d\d\d\s+-->")
NOTE = re.compile(r"^(WEBVTT|Kind:|Language:|NOTE|STYLE|REGION)")


def parse(path):
    """Yield (timestamp, text) per cue, tags and cue-settings removed."""
    stamp = None
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\n")
        if CUE.match(line):
            stamp = line.split(" --> ")[0][:8]
            continue
        if not line.strip() or NOTE.match(line) or line.strip().isdigit():
            continue
        text = TAG.sub("", line).strip()
        if text:
            yield stamp, text


def dedupe(cues):
    """Drop the rolling-window repetition YouTube emits."""
    out, tail = [], ""
    for stamp, text in cues:
        if text == "[Music]" or not text:
            continue
        # The cue is wholly contained in what we already have.
        if text in tail:
            continue
        # The cue extends the tail: keep only the new suffix.
        overlap = 0
        for n in range(min(len(tail), len(text)), 0, -1):
            if tail.endswith(text[:n]):
                overlap = n
                break
        addition = text[overlap:].strip()
        if addition:
            out.append((stamp, addition))
            tail = (tail + " " + addition)[-400:]
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("usage: vtt-to-text.py <file.vtt> [--keep-timestamps]")
    keep = "--keep-timestamps" in sys.argv
    cues = dedupe(parse(args[0]))
    if not cues:
        sys.exit("error: no caption text found — the VTT is empty or unparseable")
    if keep:
        for stamp, text in cues:
            print(f"[{stamp}] {text}")
    else:
        # Re-wrap into paragraphs so the result reads as prose.
        words, line = [], ""
        for _, text in cues:
            for w in text.split():
                if len(line) + len(w) > 90:
                    words.append(line)
                    line = w
                else:
                    line = f"{line} {w}".strip()
        if line:
            words.append(line)
        print("\n".join(words))


if __name__ == "__main__":
    main()
