#!/usr/bin/env python3
"""Time a song's lyrics to one recording of it.

Transcribes the recording with faster-whisper (word timestamps), lines the
lyric words up with the heard words, and writes timing.json: when each lyric
line starts, in the order the page parses the lyrics, plus a fingerprint of
those lines so the page uses the timing only with the note it was made from.

    align.py AUDIO LYRICS --out DIR [--model small.en] [--check]
    align.py AUDIO LYRICS --out DIR --check-only      # re-check DIR/timing.json

AUDIO is any file ffmpeg reads. LYRICS is the note's text: timed lines
("[01:23.45] words") or plain lines. The words never leave this machine, and
timing.json holds no words.

Needs ffmpeg and `pip install faster-whisper`; the first run downloads the
speech model from Hugging Face (small.en is about 500 MB).
"""

import argparse
import difflib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SR = 16000
STAMP = re.compile(r"^\[([0-9]{1,2}):([0-9]{1,2}(?:[.:][0-9]{1,3})?)\]")
META = re.compile(r"^\[[a-z]+\s*:[^\]]*\]$", re.IGNORECASE)
HEADING = re.compile(r"^#{1,6}\s")


def die(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


# ---------- lyrics, parsed exactly as template.html parses them ----------

def trim(s):
    return s.strip().strip("﻿").strip()


def parse_lyrics(text):
    """Entries in page order: [(note_time_or_None, line_text)], and whether timed."""
    timed, plain = [], []
    for raw in re.split(r"\r?\n", text):
        line = trim(raw)
        rest, stamps = line, []
        while True:
            m = STAMP.match(rest)
            if not m:
                break
            stamps.append(int(m.group(1)) * 60 + float(m.group(2).replace(":", ".")))
            rest = rest[m.end():]
        if stamps:
            timed.extend((t, trim(rest)) for t in stamps)
            continue
        if META.match(line):
            continue
        if line and not HEADING.match(line):
            plain.append(line)
    if timed:
        timed.sort(key=lambda e: e[0])  # stable, like Array.prototype.sort
        return timed, True
    return [(None, t) for t in plain], False


def fingerprint(texts):
    """The page's hash(): djb2 over UTF-16 code units, base 36."""
    data = "\n".join(texts).encode("utf-16-le")
    h = 5381
    for i in range(0, len(data), 2):
        h = (h * 33 + (data[i] | data[i + 1] << 8)) & 0xFFFFFFFF
    digits, out = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while True:
        h, r = divmod(h, 36)
        out = digits[r] + out
        if not h:
            return out


def tokens(text):
    return re.findall(r"[a-z0-9]+", re.sub(r"[’'`]", "", text.lower()))


# ---------- audio ----------

def decode(audio_path):
    if not shutil.which("ffmpeg"):
        die("ffmpeg is not installed")
    import numpy as np
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(audio_path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def load_model(name):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        die("faster-whisper is not installed: pip install faster-whisper")
    return WhisperModel(name, device="cpu", compute_type="int8")


def transcribe(model, samples, prompt=None):
    segments, _ = model.transcribe(samples, language="en", word_timestamps=True, beam_size=5,
                                   condition_on_previous_text=False, vad_filter=False, initial_prompt=prompt)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2), "p": round(w.probability, 2)})
    return words


# ---------- alignment ----------

# Words too common to place a line on their own.
COMMON = set("""a an and are as at be but by for from had has have he her him his i i'm im in is it
its me my no not of on oh or our she so that the their them then there they this to too up us was
we were what when where who why will with yeah yes you your""".split())


def informative(tok):
    return tok not in COMMON and len(tok) >= 3


def similar(a, b):
    if a == b:
        return 2.0 if informative(a) else 0.7
    if len(a) > 2 and len(b) > 2 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.75:
        return 1.0
    return -1.0


def align_words(lyric, heard):
    """Semi-global alignment: free gaps at both ends of both sequences.
    Returns {lyric index: heard index} for word pairs that match."""
    n, m, GAP = len(lyric), len(heard), -0.5
    D = [[0.0] * (m + 1) for _ in range(n + 1)]
    B = [[0] * (m + 1) for _ in range(n + 1)]  # 1 diag, 2 up (skip lyric), 3 left (skip heard)
    for i in range(1, n + 1):
        B[i][0] = 2
    for j in range(1, m + 1):
        B[0][j] = 3
    for i in range(1, n + 1):
        li, Di, Dp = lyric[i - 1], D[i], D[i - 1]
        for j in range(1, m + 1):
            diag = Dp[j - 1] + similar(li, heard[j - 1])
            up = Dp[j] + GAP
            left = Di[j - 1] + GAP
            if diag >= up and diag >= left:
                Di[j], B[i][j] = diag, 1
            elif up >= left:
                Di[j], B[i][j] = up, 2
            else:
                Di[j], B[i][j] = left, 3
    # Free trailing gaps: end at the best cell on the last row or column.
    best = max([(D[n][j], n, j) for j in range(m + 1)] + [(D[i][m], i, m) for i in range(n + 1)])
    _, i, j = best
    pairs = {}
    while i > 0 and j > 0:
        b = B[i][j]
        if b == 1:
            if similar(lyric[i - 1], heard[j - 1]) > 0:
                pairs[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif b == 2:
            i -= 1
        else:
            j -= 1
    return pairs


def line_times(entries, words, min_prob=0.1):
    """When each entry starts in the recording, or None."""
    lyric, owner, pos = [], [], []
    for k, (_, text) in enumerate(entries):
        for p, tok in enumerate(tokens(text)):
            lyric.append(tok); owner.append(k); pos.append(p)
    heard_tokens, heard_index = [], []
    for wi, w in enumerate(words):
        for tok in tokens(w["w"]):
            heard_tokens.append(tok); heard_index.append(wi)
    pairs = align_words(lyric, heard_tokens)
    # Keep a match only where it is safe to time a line by: a run of matched
    # neighbours that holds an uncommon word, or three or more in a row.
    # "in the" alone matches half the songs ever written.
    keep, run = set(), []
    for li in sorted(pairs) + [None]:
        if run and (li is None or li != run[-1] + 1 or pairs[li] != pairs[run[-1]] + 1):
            if len(run) >= 3 or any(informative(lyric[x]) for x in run):
                keep.update(run)
            run = []
        if li is not None:
            run.append(li)
    pairs = {li: pairs[li] for li in keep}

    starts, ends = [None] * len(entries), [None] * len(entries)
    for li in sorted(pairs):
        w = words[heard_index[pairs[li]]]
        # Unsure words, and zero-length ones, are where the model fills silence.
        if w["p"] < min_prob or w["e"] - w["s"] < 0.05:
            continue
        k = owner[li]
        if starts[k] is None:
            # A line's first heard word may not be its first word: back up a little.
            starts[k] = max(0.0, w["s"] - 0.6 * pos[li])
        ends[k] = w["e"]

    sung = [k for k, (_, t) in enumerate(entries) if t]
    # Drop anchors that run backwards: a stray match, not the line.
    last = -1.0
    for k in sung:
        if starts[k] is not None:
            if starts[k] < last + 0.2:
                starts[k] = ends[k] = None
            else:
                last = starts[k]
    # Place a run of at most two unheard lines just before the next heard one
    # (spread evenly when the gap is short; never out into an instrumental
    # break). A longer run, or one at either end, is a part this recording
    # doesn't sing.
    run, prev = [], None
    for k in sung:
        if starts[k] is None:
            run.append(k)
            continue
        if run and len(run) <= 2 and prev is not None:
            a, b = ends[prev] or starts[prev], starts[k]
            step = min((b - a) / (len(run) + 1), 3.0)
            for i, x in enumerate(run):
                starts[x] = round(b - step * (len(run) - i), 2)
        run, prev = [], k
    # Blank entries mark a break: just after the line before, never past the next.
    for k, (_, text) in enumerate(entries):
        if text:
            continue
        prev = next((x for x in range(k - 1, -1, -1) if entries[x][1] and starts[x] is not None), None)
        nxt = next((starts[x] for x in range(k + 1, len(entries)) if entries[x][1] and starts[x] is not None), None)
        if prev is None:
            continue
        t = (ends[prev] or starts[prev]) + 1.0
        if nxt is not None:
            if nxt - t < 1.5:
                continue  # too short a break to blank the screen
            t = min(t, nxt - 0.05)
        starts[k] = round(t, 2)
    return [None if t is None else round(t, 1) for t in starts]


def default_prompt(texts):
    """The first sung line and the most repeated one. Priming with a little of
    the song helps the model hear sung words; what it invents from the prompt
    in quiet passages comes out unsure or zero-length, and line_times skips it."""
    sung = [t for t in texts if t]
    if not sung:
        return None
    counts = {}
    for t in sung:
        counts[t] = counts.get(t, 0) + 1
    chorus = max(sung, key=lambda t: (counts[t], len(t)))
    parts = [sung[0]] + ([chorus] if chorus != sung[0] else [])
    return ". ".join(parts)[:200]


# ---------- check ----------

def heard_share(line, heard):
    """The share of the line's words heard in its window, misheard ones included."""
    want, got = tokens(line), tokens(heard)
    if not want:
        return 1.0
    return sum(1 for w in want if any(similar(w, g) > 0 for g in got)) / len(want)


def check(model, samples, entries, times):
    """Transcribe each timed line's window on its own and compare with the line."""
    rows, flagged = [], 0
    timed = [k for k, (_, t) in enumerate(entries) if t and times[k] is not None]
    for k in timed:
        nxt = next((times[x] for x in range(k + 1, len(entries)) if times[x] is not None), times[k] + 6)
        s, e = max(0.0, times[k] - 0.3), max(nxt, times[k] + 2.5) + 0.3
        segs, _ = model.transcribe(samples[int(s * SR):int(e * SR)], language="en", beam_size=5,
                                   condition_on_previous_text=False, vad_filter=False)
        heard = " ".join(x.text.strip() for x in segs)
        score = heard_share(entries[k][1], heard)
        ok = score >= 0.5
        flagged += not ok
        rows.append({"entry": k, "time": times[k], "match": round(score, 2), "ok": ok,
                     "line": entries[k][1], "heard": heard})
        print(f"{'ok' if ok else '??'} {times[k]:7.1f}  {entries[k][1][:44]:44}  heard: {heard[:60]}", file=sys.stderr)
    return rows, flagged


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("lyrics")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--prompt", help="Text to prime the transcriber (default: the first line and the most repeated one)")
    ap.add_argument("--no-prompt", action="store_true", help="Transcribe with no priming")
    ap.add_argument("--check", action="store_true", help="After aligning, check each line's window")
    ap.add_argument("--check-only", action="store_true", help="Check DIR/timing.json as it stands")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    entries, timed = parse_lyrics(Path(args.lyrics).read_text(encoding="utf-8"))
    if not entries:
        die("the lyrics file has no lines")
    texts = [t for _, t in entries]
    print_ = fingerprint(texts)

    samples = decode(args.audio)
    model = load_model(args.model)

    if args.check_only:
        timing = json.loads((out / "timing.json").read_text())
        if timing.get("fingerprint") != print_ or len(timing.get("times", [])) != len(entries):
            die("timing.json was made from different lyrics; align again")
        times = timing["times"]
    else:
        words_file = out / f"words-{args.model}.json"
        if words_file.exists():
            words = json.loads(words_file.read_text())
        else:
            words = transcribe(model, samples, None if args.no_prompt else (args.prompt or default_prompt(texts)))
            words_file.write_text(json.dumps(words))
        times = line_times(entries, words)
        (out / "timing.json").write_text(json.dumps({"fingerprint": print_, "times": times}))

    result = {
        "ok": True,
        "timing": str(out / "timing.json"),
        "fingerprint": print_,
        "lyricsWereTimed": timed,
        "entries": len(entries),
        "sungLines": sum(1 for t in texts if t),
        "timedLines": sum(1 for k, t in enumerate(texts) if t and times[k] is not None),
        "untimed": [{"entry": k, "line": t} for k, t in enumerate(texts) if t and times[k] is None],
        "durationSeconds": round(len(samples) / SR, 1),
    }
    if args.check or args.check_only:
        rows, flagged = check(model, samples, entries, times)
        (out / "check.json").write_text(json.dumps(rows, indent=1))
        result["check"] = str(out / "check.json")
        result["flagged"] = flagged
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
