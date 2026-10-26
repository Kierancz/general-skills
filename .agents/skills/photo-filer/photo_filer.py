#!/usr/bin/env python3
"""File photos and videos into YEAR/YEAR-MM-DD/ folders by the date they were taken.

  python3 photo_filer.py plan  <source> [--dest DIR] [--copy] [--exclude GLOB]...   writes a plan, moves nothing
  python3 photo_filer.py apply <plan.csv>                                            carries out exactly that plan
  python3 photo_filer.py undo  <log.csv> [--run]                                     puts files back (preview without --run)

Dates come from exiftool (DateTimeOriginal, then QuickTime/EXIF/XMP create dates), then from a date in
the filename, else the file goes to Undated/. File modified times are never used. Byte-identical copies
go to _duplicates/ for review. Nothing is ever deleted, and an existing file is never overwritten.
"""

import argparse
import csv
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

IMAGE_EXT = {"jpg", "jpeg", "jpe", "heic", "heif", "png", "gif", "tif", "tiff", "webp", "bmp", "avif", "jxl"}
RAW_EXT = {"dng", "arw", "srf", "sr2", "cr2", "cr3", "crw", "nef", "nrw", "orf", "raf", "rw2", "rwl", "pef",
           "srw", "x3f", "3fr", "erf", "kdc", "dcr", "mos", "mrw", "iiq"}
VIDEO_EXT = {"mov", "mp4", "m4v", "avi", "mts", "m2ts", "3gp", "mkv", "wmv", "mpg", "mpeg", "hevc"}
MEDIA_EXT = IMAGE_EXT | RAW_EXT | VIDEO_EXT
SIDECAR_EXT = {"xmp", "aae", "thm", "dop", "pp3", "on1"}
# Folders that belong to an app: Photos, Lightroom, Aperture, Photo Booth, Luminar. Never walked into.
PACKAGE_SUFFIXES = (".photoslibrary", ".photolibrary", ".migratedphotolibrary", ".aplibrary", ".lrlibrary",
                    ".lrdata", ".lrcat-data")
PACKAGE_NAMES = {"Photo Booth Library"}
UNDATED, DUPLICATES = "Undated", "_duplicates"
SF_DATALESS = 0x40000000  # macOS: an iCloud placeholder whose bytes are not on this machine
DATE_TAGS = [("DateTimeOriginal", "exif"), ("CreationDate", "quicktime"), ("CreateDate", "create-date"),
             ("MediaCreateDate", "quicktime"), ("DateCreated", "xmp")]
SOURCE_RANK = {"exif": 0, "quicktime": 1, "create-date": 1, "xmp": 2, "pair": 2, "filename": 3, "folder": 4,
               "none": 9}
COPY_NAME = re.compile(r"( copy\d*| \(\d+\)|-\d+| \d+)$", re.I)
FN_DATE = re.compile(r"(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)")
FN_EPOCH_MS = re.compile(r"(?:mmexport|wx_camera_|FB_IMG_)(1\d{12})(?!\d)", re.I)
FIELDS = ["action", "src", "dst", "date", "date_source", "size", "mtime_ns", "sha256", "note"]
STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "photo-filer"


def die(msg):
    sys.exit(f"photo-filer: {msg}")


def ext_of(name):
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def plausible(d):
    return d is not None and 1826 <= d.year and d.date() <= dt.date.today() + dt.timedelta(days=1)


# ---------- reading the source ----------

def is_package(dirpath, name):
    if name in PACKAGE_NAMES or name.lower().endswith(PACKAGE_SUFFIXES):
        return True
    try:
        return any(e.lower().endswith(".lrcat") for e in os.listdir(os.path.join(dirpath, name)))
    except OSError:
        return True


def catalog_folders(catalogs):
    """Folders a Lightroom catalog tracks. Moving their files breaks the catalog's links."""
    tracked, notes = set(), []
    for cat in catalogs:
        try:
            con = sqlite3.connect(f"file:{cat}?mode=ro&immutable=1", uri=True)
            rows = con.execute("select r.absolutePath || f.pathFromRoot from AgLibraryFolder f "
                               "join AgLibraryRootFolder r on f.rootFolder = r.id_local").fetchall()
            con.close()
        except sqlite3.Error as e:
            notes.append(f"could not read Lightroom catalog {cat}: {e}. Only its own folder is skipped; "
                         "pass --exclude for any folder it manages")
            continue
        paths = {os.path.normpath(r[0]) for r in rows if r[0]}
        live = {p for p in paths if os.path.isdir(p)}
        tracked |= live
        notes.append(f"Lightroom catalog {cat}: tracks {len(paths)} folders, {len(live)} of them exist on this "
                     f"machine" + ("" if live else " (its links are already broken; moving files will not "
                                                   "break them further)"))
    return tracked, notes


def walk(source, excludes, dest):
    """Yield media and sidecar files, and count what is left alone and why."""
    media, sidecars, skipped, catalogs = [], [], Counter(), []
    own = {os.path.join(dest, UNDATED), os.path.join(dest, DUPLICATES)}
    for dirpath, dirnames, filenames in os.walk(source):
        keep = []
        for d in sorted(dirnames):
            full = os.path.join(dirpath, d)
            if d.startswith("."):
                continue
            if full in own:
                skipped[f"photo-filer's own folder: {os.path.relpath(full, source)}"] += 1
                continue
            if is_package(dirpath, d):
                skipped[f"app library or catalog folder: {os.path.relpath(full, source)}"] += 1
                catalogs += [os.path.join(full, e) for e in os.listdir(full) if e.lower().endswith(".lrcat")] \
                    if os.access(full, os.R_OK) else []
                continue
            if any(fnmatch.fnmatch(os.path.relpath(full, source), g) for g in excludes):
                skipped[f"excluded: {os.path.relpath(full, source)}"] += 1
                continue
            keep.append(d)
        dirnames[:] = keep
        for fn in sorted(filenames):
            p = os.path.join(dirpath, fn)
            if fn.startswith("."):
                continue
            if any(fnmatch.fnmatch(os.path.relpath(p, source), g) for g in excludes):
                skipped["excluded file"] += 1
                continue
            if os.path.islink(p):
                skipped["symlink"] += 1
                continue
            st = os.stat(p)
            if getattr(st, "st_flags", 0) & SF_DATALESS:
                skipped["iCloud placeholder, not downloaded"] += 1
                continue
            e = ext_of(fn)
            rec = {"path": p, "dir": dirpath, "name": fn, "ext": e, "stem": fn[: -len(e) - 1].lower() if e else fn.lower(),
                   "size": st.st_size, "mtime_ns": st.st_mtime_ns}
            if e in MEDIA_EXT:
                media.append(rec)
            elif e in SIDECAR_EXT:
                sidecars.append(rec)
            elif e == "lrcat":
                catalogs.append(p)
                skipped["Lightroom catalog file"] += 1
            else:
                skipped[f"not a photo or video (.{e or 'no extension'})"] += 1
    return media, sidecars, skipped, catalogs


def exif_dates(paths):
    if not shutil.which("exiftool"):
        die("exiftool is not installed. On macOS: brew install exiftool")
    out = {}
    for i in range(0, len(paths), 2000):
        batch = paths[i:i + 2000]
        args = ["exiftool", "-j", "-q", "-q", "-charset", "filename=utf8", "-api", "QuickTimeUTC=1",
                "-api", "LargeFileSupport=1", "-d", "%Y-%m-%d %H:%M:%S"] + [f"-{t}" for t, _ in DATE_TAGS] + ["-@", "-"]
        res = subprocess.run(args, input="\n".join(batch), capture_output=True, text=True)
        try:
            rows = json.loads(res.stdout) if res.stdout.strip() else []
        except ValueError:
            die(f"could not parse exiftool output: {res.stderr.strip()[:300]}")
        for row in rows:
            for tag, label in DATE_TAGS:
                v = row.get(tag)
                if isinstance(v, str):
                    try:
                        d = dt.datetime.strptime(v[:19], "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        continue
                    if plausible(d):
                        out[os.path.normpath(row["SourceFile"])] = (d, label)
                        break
    return out


def folder_date(dirpath):
    """A file already sitting in YEAR/YEAR-MM-DD/ was dated by someone. Only this exact scheme counts."""
    day, year = os.path.basename(dirpath), os.path.basename(os.path.dirname(dirpath))
    m = re.fullmatch(r"((?:18|19|20)\d{2})-(\d{2})-(\d{2})", day)
    if not m or m.group(1) != year:
        return None
    try:
        d = dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return d if plausible(d) else None


def filename_date(name):
    m = FN_EPOCH_MS.search(name)
    if m:
        d = dt.datetime.fromtimestamp(int(m.group(1)) / 1000)
        return d if plausible(d) else None
    m = FN_DATE.search(name)
    if m:
        try:
            d = dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
        return d if plausible(d) else None
    return None


# ---------- planning ----------

class Names:
    """Hands out target paths that collide with neither an existing file nor another planned one.
    Compared case-insensitively, because the default macOS volume is. A path someone else's file
    occupies is never reused, even if that file is about to move: apply runs in order, not all at once."""

    def __init__(self):
        self.taken = set()

    def claim(self, directory, name, src_hash_fn=None):
        stem, dot, e = name.rpartition(".")
        if not dot:
            stem, e = name, ""
        n = 0
        while True:
            cand = os.path.join(directory, name if n == 0 else f"{stem}-{n}{dot}{e}")
            k = os.path.normcase(cand).lower()
            if k not in self.taken and not os.path.lexists(cand):
                self.taken.add(k)
                return cand, None
            if k not in self.taken and os.path.isfile(cand) and src_hash_fn and src_hash_fn(cand):
                return cand, "identical file already there"
            n += 1


def plan(args):
    source = os.path.realpath(args.source)
    dest = os.path.realpath(args.dest or args.source)
    if not os.path.isdir(source):
        die(f"not a directory: {source}")
    if source in (os.path.realpath(Path.home()), "/"):
        die("refusing to file a whole home folder or disk; point it at a photo folder")
    for p in (source, dest):
        if any(part.lower().endswith(PACKAGE_SUFFIXES) or part in PACKAGE_NAMES for part in Path(p).parts):
            die(f"{p} is inside an app's library; export from the app instead of filing its files")
    media, sidecars, skipped, catalogs = walk(source, args.exclude, dest)
    tracked, notes = catalog_folders(catalogs + [os.path.realpath(c) for c in args.catalog])
    if tracked:
        managed = [m for m in media if os.path.normpath(m["dir"]) in tracked]
        if managed:
            skipped["in a folder a Lightroom catalog tracks"] += len(managed)
            ids = {id(m) for m in managed}
            media = [m for m in media if id(m) not in ids]

    print(f"reading dates from {len(media)} files with exiftool...", file=sys.stderr)
    dates = exif_dates([m["path"] for m in media])
    for m in media:
        d = dates.get(os.path.normpath(m["path"]))
        if d:
            m["date"], m["source"] = d
        elif filename_date(m["name"]):
            m["date"], m["source"] = filename_date(m["name"]), "filename"
        elif folder_date(m["dir"]):
            m["date"], m["source"] = folder_date(m["dir"]), "folder"
        else:
            m["date"], m["source"] = None, "none"

    # Live Photos: a .mov next to a photo with the same name goes where the photo goes.
    by_stem = defaultdict(list)
    for m in media:
        by_stem[(m["dir"], m["stem"])].append(m)
    for group in by_stem.values():
        stills = [m for m in group if m["ext"] not in VIDEO_EXT and m["date"]]
        for v in (m for m in group if m["ext"] in VIDEO_EXT):
            if stills:
                best = min(stills, key=lambda s: SOURCE_RANK[s["source"]])
                if SOURCE_RANK[best["source"]] <= SOURCE_RANK[v["source"]] or v["date"] is None:
                    v["date"], v["source"], v["pair"] = best["date"], "pair", best["name"]

    def target_dir(m):
        if m["date"] is None:
            return os.path.normpath(os.path.join(dest, UNDATED, os.path.relpath(m["dir"], source)))
        return os.path.join(dest, m["date"].strftime("%Y"), m["date"].strftime("%Y-%m-%d"))

    def dup_dir(m):
        return os.path.normpath(os.path.join(dest, DUPLICATES, os.path.relpath(m["dir"], source)))

    # Exact duplicates: same size, then same SHA-256.
    hashes = {}

    def h(path):
        if path not in hashes:
            hashes[path] = sha256(path)
        return hashes[path]

    by_size = defaultdict(list)
    for m in media:
        by_size[m["size"]].append(m)
    dup_of = {}
    for group in (g for g in by_size.values() if len(g) > 1 and g[0]["size"] > 0):
        by_hash = defaultdict(list)
        for m in group:
            by_hash[h(m["path"])].append(m)
        for same in (g for g in by_hash.values() if len(g) > 1):
            def keeper_rank(m):
                stem = m["name"].rsplit(".", 1)[0]
                in_place = os.path.normpath(m["dir"]) == os.path.normpath(target_dir(m))
                return (not in_place, SOURCE_RANK[m["source"]], bool(COPY_NAME.search(stem)), len(m["path"]), m["path"])
            keep, *rest = sorted(same, key=keeper_rank)
            for r in rest:
                dup_of[id(r)] = keep["path"]

    names = Names()
    rows, moved_out = [], Counter()
    # Files already in the right folder claim their names first, so nothing gets renamed around them.
    ordered = sorted(media, key=lambda m: (os.path.normpath(m["dir"]) != os.path.normpath(target_dir(m)), m["path"]))
    stays = set()
    for m in ordered:
        if id(m) in dup_of or os.path.normpath(m["dir"]) != os.path.normpath(target_dir(m)):
            continue
        names.taken.add(os.path.normcase(m["path"]).lower())
        stays.add(id(m))
    for m in ordered:
        base = {"date": m["date"].strftime("%Y-%m-%d %H:%M:%S") if m["date"] else "", "date_source": m["source"],
                "size": m["size"], "mtime_ns": m["mtime_ns"], "sha256": hashes.get(m["path"], ""), "src": m["path"]}
        note = f"Live Photo video of {m['pair']}" if m.get("pair") else ""
        if id(m) in dup_of:
            d, _ = names.claim(dup_dir(m), m["name"])
            rows.append({**base, "action": "duplicate", "dst": d, "note": f"same bytes as {dup_of[id(m)]}"})
            moved_out[m["dir"]] += 1
            continue
        if id(m) in stays:
            rows.append({**base, "action": "keep", "dst": m["path"], "note": "already filed"})
            continue
        same_bytes = (lambda other, src=m["path"]: os.path.getsize(other) == os.path.getsize(src)
                      and h(other) == h(src))
        d, why = names.claim(target_dir(m), m["name"], same_bytes)
        if why:
            rows.append({**base, "action": "duplicate",
                         "dst": names.claim(dup_dir(m), m["name"])[0],
                         "note": f"same bytes as {d}"})
        else:
            rows.append({**base, "action": "undated" if m["date"] is None else "file", "dst": d, "note": note})
        moved_out[m["dir"]] += 1

    # Sidecars travel with the photo they belong to (IMG_1.xmp or IMG_1.JPG.xmp beside IMG_1.JPG).
    dst_of = {r["src"]: r for r in rows}
    primaries = defaultdict(list)
    for m in media:
        primaries[(m["dir"], m["stem"])].append(m)
        primaries[(m["dir"], m["name"].lower())].append(m)
    for s in sidecars:
        owners = primaries.get((s["dir"], s["stem"]), [])
        owner = min(owners, key=lambda m: (m["ext"] in VIDEO_EXT, m["ext"] not in RAW_EXT), default=None)
        base = {"date": "", "date_source": "", "size": s["size"], "mtime_ns": s["mtime_ns"], "sha256": "", "src": s["path"]}
        r = dst_of.get(owner["path"]) if owner else None
        if not r:
            skipped["sidecar with no photo beside it"] += 1
            continue
        if r["action"] == "keep":
            rows.append({**base, "action": "keep", "dst": s["path"], "note": f"sidecar of {owner['name']}"})
            continue
        d, _ = names.claim(os.path.dirname(r["dst"]), s["name"])
        rows.append({**base, "action": "sidecar", "dst": d, "note": f"sidecar of {owner['name']}"})
        moved_out[s["dir"]] += 1

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    plan_path = Path(args.plan or STATE_DIR / f"plan-{stamp}.csv")
    with open(plan_path, "w", newline="") as f:
        f.write(f"# photo-filer plan; mode={'copy' if args.copy else 'move'}; source={source}; dest={dest}\n")
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    summarize(rows, skipped, notes, moved_out, media, sidecars, args.copy, plan_path, source, dest)


def summarize(rows, skipped, notes, moved_out, media, sidecars, copy, plan_path, source, dest):
    acts = Counter(r["action"] for r in rows)
    srcs = Counter(r["date_source"] for r in rows if r["date_source"])
    dup_bytes = sum(int(r["size"]) for r in rows if r["action"] == "duplicate")
    verb = "copy" if copy else "move"
    print(f"\nPLAN ({verb} mode, nothing has changed yet)")
    print(f"  source: {source}\n  dest:   {dest}")
    print(f"  {len(media)} photos/videos, {len(sidecars)} sidecars")
    labels = [("file", f"{verb} into YEAR/YEAR-MM-DD"), ("keep", "already in the right folder"),
              ("undated", f"no date anywhere: {verb} to {UNDATED}/"),
              ("duplicate", f"byte-identical copy: {verb} to {DUPLICATES}/ for review"),
              ("sidecar", f"sidecar ({'/'.join(sorted(SIDECAR_EXT))}) follows its photo")]
    for key, text in labels:
        if acts[key]:
            print(f"  {acts[key]:6}  {text}")
    if dup_bytes:
        print(f"          duplicates total {dup_bytes / 1e9:.2f} GB")
    print("  dated by: " + ", ".join(f"{k} {v}" for k, v in srcs.most_common()))
    if skipped:
        print("  left alone:")
        for k, v in sorted(skipped.items(), key=lambda kv: -kv[1]):
            print(f"    {v:6}  {k}")
    for n in notes:
        print(f"  note: {n}")
    refiled = sum(1 for r in rows if r["action"] == "file" and folder_date(os.path.dirname(r["src"])))
    if refiled:
        print(f"  {refiled} files already sit in a date folder, but their metadata says another day; they move")
    emptied = []
    for d, n in moved_out.items():
        try:
            left = [e for e in os.listdir(d) if not e.startswith(".")]
        except OSError:
            continue
        if not copy and n >= len(left) and os.path.normpath(d) != os.path.normpath(source):
            emptied.append(os.path.relpath(d, source))
    if emptied:
        print(f"  folders this empties ({len(emptied)}); a folder name is lost once its files move:")
        for e in sorted(emptied)[:15]:
            print(f"    {e}")
        if len(emptied) > 15:
            print(f"    ...and {len(emptied) - 15} more")
    sample = [r for r in rows if r["action"] in ("file", "undated", "duplicate")][:12]
    if sample:
        print("  examples:")
        for r in sample:
            print(f"    {os.path.relpath(r['src'], source)}  ->  {os.path.relpath(r['dst'], dest)}  [{r['date_source']}]")
    print(f"\n  full plan: {plan_path}")
    print(f"  to carry it out: python3 \"{os.path.abspath(__file__)}\" apply \"{plan_path}\"")


# ---------- applying and undoing ----------

def read_plan(path):
    with open(path, newline="") as f:
        header = f.readline()
        if not header.startswith("# photo-filer plan"):
            die(f"{path} is not a photo-filer plan")
        meta = dict(kv.split("=", 1) for kv in header[2:].strip().split("; ")[1:])
        return meta, list(csv.DictReader(f))


def transfer(src, dst, copy, expect_hash):
    """Move or copy without ever overwriting. Across volumes, copy, verify the bytes, then remove the source."""
    if os.path.lexists(dst):
        raise FileExistsError(f"target exists: {dst}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not copy and os.stat(src).st_dev == os.stat(os.path.dirname(dst)).st_dev:
        os.rename(src, dst)
        return
    tmp = dst + ".photo-filer-partial"
    try:
        shutil.copy2(src, tmp)
        if sha256(tmp) != (expect_hash or sha256(src)):
            raise IOError("copy did not match the original; original left in place")
        os.rename(tmp, dst)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)  # our own half-written copy, never the original
        raise
    if not copy:
        os.unlink(src)


def existing_parent(p):
    while not os.path.exists(p):
        p = os.path.dirname(p)
    return p


def same_volume(src, dst):
    try:
        return os.stat(src).st_dev == os.stat(existing_parent(os.path.dirname(dst))).st_dev
    except OSError:
        return True  # a missing source fails on its own row


def apply(args):
    meta, rows = read_plan(args.plan)
    copy = meta.get("mode") == "copy"
    stem = Path(args.plan).stem
    log_path = Path(args.plan).with_name((stem.replace("plan-", "log-", 1) if stem.startswith("plan-") else f"log-{stem}") + ".csv")
    if log_path.exists():
        die(f"{log_path} already exists: this plan was applied already. Make a new plan")
    need = sum(int(r["size"]) for r in rows if r["action"] != "keep" and (copy or not same_volume(r["src"], r["dst"])))
    free = shutil.disk_usage(existing_parent(meta["dest"])).free
    if need > free * 0.98:
        die(f"needs {need / 1e9:.2f} GB on {meta['dest']} but only {free / 1e9:.2f} GB is free; nothing was changed")
    done = Counter()
    with open(log_path, "w", newline="") as f:
        f.write(f"# photo-filer log; mode={meta.get('mode')}; dest={meta.get('dest')}; plan={args.plan}\n")
        w = csv.DictWriter(f, fieldnames=FIELDS + ["status", "error"])
        w.writeheader()
        for r in rows:
            if r["action"] == "keep":
                continue
            status, err = "done", ""
            try:
                st = os.stat(r["src"])
                if st.st_size != int(r["size"]) or st.st_mtime_ns != int(r["mtime_ns"]):
                    raise RuntimeError("file changed since the plan was made; re-run plan")
                transfer(r["src"], r["dst"], copy, r["sha256"])
            except (OSError, RuntimeError) as e:
                status, err = "failed", str(e)
            w.writerow({**r, "status": status, "error": err})
            f.flush()
            done[(r["action"], status)] += 1
    for (action, status), n in sorted(done.items()):
        print(f"  {n:6}  {action} {status}")
    print(f"  log: {log_path}\n  undo: python3 \"{os.path.abspath(__file__)}\" undo \"{log_path}\"")
    if any(s == "failed" for _, s in done):
        sys.exit(1)


def prune_empty(d, stop):
    """Remove folders this tool created and emptied, up to the library root. rmdir refuses non-empty ones."""
    stop = os.path.normpath(stop or "/")
    d = os.path.normpath(d)
    while d.startswith(stop + os.sep):
        try:
            os.rmdir(d)
        except OSError:
            return
        d = os.path.dirname(d)


def undo(args):
    with open(args.log, newline="") as f:
        header = f.readline()
        if not header.startswith("# photo-filer log"):
            die(f"{args.log} is not a photo-filer log")
        meta = dict(kv.split("=", 1) for kv in header[2:].strip().split("; ")[1:])
        copy = meta.get("mode") == "copy"
        rows = [r for r in csv.DictReader(f) if r["status"] == "done"]
    result = Counter()
    for r in reversed(rows):
        src, dst = r["src"], r["dst"]
        if not os.path.exists(dst):
            result["skipped: no longer at its filed place"] += 1
            continue
        if copy:
            # Undoing a copy removes the copy, and only when it still matches the untouched original.
            if not os.path.exists(src) or (r["sha256"] or sha256(src)) != sha256(dst):
                result["skipped: copy differs from the original or the original is gone"] += 1
                continue
            if args.run:
                os.unlink(dst)
                prune_empty(os.path.dirname(dst), meta.get("dest"))
            result["copy removed" if args.run else "copy would be removed"] += 1
            continue
        if os.path.lexists(src):
            result["skipped: something is already at the original path"] += 1
            continue
        if args.run:
            transfer(dst, src, False, r["sha256"])
            prune_empty(os.path.dirname(dst), meta.get("dest"))
        result["moved back" if args.run else "would move back"] += 1
    for k, v in result.most_common():
        print(f"  {v:6}  {k}")
    if not args.run:
        print("  preview only; add --run to do it")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan", help="work out what would move where; changes nothing")
    p.add_argument("source")
    p.add_argument("--dest", help="library root to file into (default: the source folder itself)")
    p.add_argument("--copy", action="store_true", help="copy instead of move; originals stay put")
    p.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                   help="relative path pattern to leave alone, e.g. 'portfolio' or 'EchoLake/*'; repeatable")
    p.add_argument("--catalog", action="append", default=[], metavar="LRCAT",
                   help="a Lightroom catalog outside the source whose folders must not be touched")
    p.add_argument("--plan", help=f"where to write the plan (default: {STATE_DIR}/plan-<time>.csv)")
    p.set_defaults(func=plan)
    p = sub.add_parser("apply", help="carry out a plan exactly")
    p.add_argument("plan")
    p.set_defaults(func=apply)
    p = sub.add_parser("undo", help="reverse an applied plan from its log")
    p.add_argument("log")
    p.add_argument("--run", action="store_true")
    p.set_defaults(func=undo)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
