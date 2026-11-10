#!/usr/bin/env python3
"""Build a one-page polaroid site from a photo and a caption.

  polaroid.py PHOTO [--caption TEXT] --out DIR [--date TEXT] [--note TEXT]
              [--meta LABEL=TEXT ...] [--no-camera] [--original] [--url URL]

PHOTO is a local .jpg/.png, or a Mossbear photo: its id or its artifact
URL (…/artifact/<id>). A Mossbear
photo is fetched as its display copy, which never carries location or
camera metadata. Either way the image is written without metadata
segments, so a phone photo's GPS position cannot ride along.

Without --caption, a Mossbear photo is captioned with its description, the
person's own words saved with it. A local file always needs --caption.

The back of the card lists the camera, lens, exposure and date taken,
read from an allowlist of EXIF tags (the GPS block is never followed),
plus the size, any --meta lines and the --note.

Writes DIR/index.html (from template.html) and DIR/photo.<ext> (plus
DIR/preview.<ext> for a Mossbear photo), ready for the deploy-site skill,
and prints one JSON object. Link-preview images need an absolute URL, so
they are added by a second run with --url once the first deploy has named
the site. Standard library only.
"""

import argparse
import html
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_DASHBOARD = "https://app.mossbear.io"
TEMPLATE = Path(__file__).with_name("template.html")
ID = re.compile(r"^[A-Za-z0-9_-]{10,64}$")


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


# ── getting the photo ────────────────────────────────────────────────────────

def mossbear_id(photo):
    """The artifact id in an id or a dashboard URL, or None for a local path."""
    if Path(photo).expanduser().exists():
        return None
    m = re.search(r"[?&]note=([A-Za-z0-9_-]+)", photo) or re.search(r"/artifact/([A-Za-z0-9_-]+)", photo)
    if m:
        return m.group(1)
    return photo if ID.match(photo) else None


def mossbear_config():
    try:
        return json.loads((Path.home() / ".mossbear" / "config.json").read_text())
    except (OSError, ValueError):
        return {}


def api_get(path):
    """GET a dashboard API path with the credential the CLI already has; returns the body."""
    config = mossbear_config()
    token = os.environ.get("MOSSBEAR_TOKEN", "").strip() or config.get("token")
    if not token:
        fail("no Mossbear credential here: run `mossbear login`, or pull the photo with the MCP pull tool and pass its path")
    base = (os.environ.get("MOSSBEAR_DASHBOARD_URL", "").strip() or config.get("dashboardUrl") or DEFAULT_DASHBOARD).rstrip("/")
    req = urllib.request.Request(f"{base}{path}")
    req.add_header("Authorization", f"Bearer {token}")
    # Cloudflare in front of the dashboard refuses urllib's default User-Agent (error 1010).
    req.add_header("User-Agent", "mossbear-polaroid-skill/1")
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def fetch_part(item_id, role="display"):
    """One copy of a Mossbear photo (`display` or `thumb`), through the same endpoint the CLI reads."""
    try:
        return api_get(f"/api/v1/artifacts/{item_id}/assets/{role}")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            fail(f"no photo {item_id} in this Mossbear account (it may be a text note, or deleted)")
        fail(f"fetching photo {item_id} -> HTTP {err.code}")
    except urllib.error.URLError as err:
        fail(f"fetching photo {item_id}: {err.reason}")


def fetch_description(item_id):
    """The photo's description, the person's words saved with it, or None when it has none."""
    try:
        artifact = json.loads(api_get(f"/api/v1/artifacts/{item_id}")).get("artifact") or {}
    except urllib.error.HTTPError as err:
        fail(f"reading the description of photo {item_id} -> HTTP {err.code}; pass --caption instead")
    except (urllib.error.URLError, ValueError) as err:
        fail(f"reading the description of photo {item_id}: {getattr(err, 'reason', err)}; pass --caption instead")
    description = artifact.get("description")
    return (description.strip() or None) if isinstance(description, str) else None


# ── stripping metadata and reading size ──────────────────────────────────────

def exif_orientation(segment):
    """The Orientation tag (1-8) of an EXIF APP1 segment, or 1."""
    body = segment[4:]
    if not body.startswith(b"Exif\x00\x00"):
        return 1
    tiff = body[6:]
    try:
        end = {b"II": "<", b"MM": ">"}[tiff[:2]]
        ifd = struct.unpack(end + "I", tiff[4:8])[0]
        for n in range(struct.unpack(end + "H", tiff[ifd:ifd + 2])[0]):
            entry = tiff[ifd + 2 + 12 * n: ifd + 14 + 12 * n]
            if struct.unpack(end + "H", entry[:2])[0] == 0x0112:
                value = struct.unpack(end + "H", entry[8:10])[0]
                return value if 1 <= value <= 8 else 1
    except (KeyError, struct.error, IndexError):
        pass
    return 1


def orientation_only(value):
    """A minimal EXIF APP1 that carries nothing but the Orientation tag."""
    tiff = b"MM\x00*" + struct.pack(">I", 8) + struct.pack(">H", 1)
    tiff += struct.pack(">HHIHH", 0x0112, 3, 1, value, 0) + struct.pack(">I", 0)
    body = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body


# Segments that draw the image. Everything else (EXIF/XMP in APP1, other APPn
# blocks, comments, unknown markers, anything after the end-of-image marker) is
# dropped: an allowlist, so a metadata carrier nobody listed cannot slip through.
JPEG_KEEP = {
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,  # frame headers
    0xC4, 0xCC, 0xDB, 0xDD,  # Huffman and arithmetic tables, quantization tables, restart interval
    0xE0, 0xE2, 0xEE,  # JFIF, ICC colour profile, Adobe colour transform
}


def strip_jpeg(data):
    """Rebuild a JPEG from its image segments alone, walking every scan to the end-of-image marker.

    The one EXIF field kept is Orientation, re-written on its own: without it a
    phone photo taken sideways would display sideways.
    """
    if data[:2] != b"\xff\xd8":
        fail("not a JPEG")
    out, i, size, orientation = bytearray(b"\xff\xd8"), 2, None, 1
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            fail("damaged JPEG")
        while i + 1 < n and data[i + 1] == 0xFF:  # fill bytes before a marker
            i += 1
        if i + 1 >= n:
            break
        marker = data[i + 1]
        if marker == 0xD9:
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:  # markers with no length
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        segment = data[i:i + 2 + length]
        i += 2 + length
        if marker == 0xDA:
            # A scan header, then entropy-coded data up to the next real marker
            # (0xFF00 is an escaped byte and 0xFFD0-D7 are restarts, both part of
            # the data). Progressive files repeat this, with tables between scans.
            j = i
            while j + 1 < n and not (data[j] == 0xFF and data[j + 1] != 0x00 and not 0xD0 <= data[j + 1] <= 0xD7):
                j += 1
            out += segment + data[i:j]
            i = j
            continue
        if marker in (0xC0, 0xC1, 0xC2, 0xC3) and size is None:
            h, w = struct.unpack(">HH", segment[5:9])
            size = (w, h)
        if marker == 0xE1 and orientation == 1:
            orientation = exif_orientation(segment)
        if marker in JPEG_KEEP:
            out += segment
    out += b"\xff\xd9"
    if orientation != 1:
        out[2:2] = orientation_only(orientation)
        if orientation >= 5 and size:  # rotated a quarter turn: displayed width and height swap
            size = (size[1], size[0])
    return bytes(out), size


# Chunks that draw the image; text, EXIF, timestamps, private chunks and
# anything after IEND are dropped.
PNG_KEEP = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT"}


def strip_png(data):
    """Rebuild a PNG from the chunks that draw it, stopping at IEND."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        fail("not a PNG")
    out, i = bytearray(data[:8]), 8
    w, h = struct.unpack(">II", data[16:24])
    while i + 8 <= len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        if kind in PNG_KEEP:
            out += data[i:i + 12 + length]
        i += 12 + length
        if kind == b"IEND":
            break
    return bytes(out), (w, h)


def clean(data):
    if data[:2] == b"\xff\xd8":
        return (*strip_jpeg(data), "jpg")
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return (*strip_png(data), "png")
    fail("only JPEG and PNG photos are supported; convert HEIC or WebP to JPEG first")


# ── what goes on the back ────────────────────────────────────────────────────

# Read by tag number from IFD0 and the Exif sub-IFD only. The GPS sub-IFD
# (tag 0x8825) is never followed, so a location cannot reach the page.
CAMERA_TAGS = {0x010F: "make", 0x0110: "model"}
EXIF_TAGS = {
    0x9003: "taken", 0x829D: "fnumber", 0x829A: "exposure", 0x8827: "iso",
    0x920A: "focal", 0xA405: "focal35", 0xA434: "lens",
}


def camera_details(raw):
    """Camera, lens, exposure and date taken from the first EXIF block in any file, or {}."""
    at = raw.find(b"Exif\x00\x00")
    if at < 0:
        return {}
    tiff = raw[at + 6:]
    try:
        end = {b"II": "<", b"MM": ">"}[tiff[:2]]
    except KeyError:
        return {}

    def value(entry):
        kind, count = struct.unpack(end + "HI", entry[2:8])
        size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}.get(kind, 1) * count
        blob = entry[8:8 + size] if size <= 4 else tiff[struct.unpack(end + "I", entry[8:12])[0]:][:size]
        if kind == 2:
            return blob.split(b"\x00")[0].decode("utf-8", "replace").strip()
        if kind == 3:
            return struct.unpack(end + "H", blob[:2])[0]
        if kind == 4:
            return struct.unpack(end + "I", blob[:4])[0]
        if kind in (5, 10):
            n, d = struct.unpack(end + ("II" if kind == 5 else "ii"), blob[:8])
            return n / d if d else None
        return None

    def ifd(offset, wanted):
        found, pointer = {}, None
        count = struct.unpack(end + "H", tiff[offset:offset + 2])[0]
        for n in range(count):
            entry = tiff[offset + 2 + 12 * n: offset + 14 + 12 * n]
            tag = struct.unpack(end + "H", entry[:2])[0]
            if tag == 0x8769:
                pointer = struct.unpack(end + "I", entry[8:12])[0]
            elif tag in wanted:
                found[wanted[tag]] = value(entry)
        return found, pointer

    try:
        found, pointer = ifd(struct.unpack(end + "I", tiff[4:8])[0], CAMERA_TAGS)
        if pointer:
            found.update(ifd(pointer, EXIF_TAGS)[0])
    except (struct.error, IndexError, ZeroDivisionError):
        return {}
    return {k: v for k, v in found.items() if v not in (None, "", 0)}


def detail_rows(cam, size):
    """The labelled lines on the back of the card, in reading order."""
    rows = []
    if isinstance(cam.get("taken"), str):
        try:
            when = datetime.strptime(cam["taken"], "%Y:%m:%d %H:%M:%S")
            rows.append(("Taken", f"{when.day} {when:%B %Y}, {when:%I:%M %p}".replace(" 0", " ")))
        except ValueError:
            pass
    make, model = cam.get("make", ""), cam.get("model", "")
    if model or make:
        rows.append(("Camera", model if model.lower().startswith(make.lower()) else f"{make} {model}".strip()))
    if isinstance(cam.get("lens"), str):
        # Phones repeat the model in the lens name ("iPhone 15 Pro back camera …"); say it once.
        lens = cam["lens"]
        rows.append(("Lens", lens[len(model):].strip() if model and lens.startswith(model) else lens))
    exposure = []
    if cam.get("fnumber"):
        exposure.append(f"f/{cam['fnumber']:.1f}".replace(".0", ""))
    if cam.get("exposure"):
        t = cam["exposure"]
        exposure.append(f"1/{round(1 / t)} s" if t < 1 else f"{t:g} s")
    if cam.get("iso"):
        exposure.append(f"ISO {cam['iso']}")
    focal = cam.get("focal35") or cam.get("focal")
    if focal:
        exposure.append(f"{round(focal)} mm")
    if exposure:
        rows.append(("Exposure", " · ".join(exposure)))
    rows.append(("Size", f"{size[0]} × {size[1]}"))
    return rows


# ── the page ─────────────────────────────────────────────────────────────────



def share_tags(url, preview, size):
    """Link-preview tags. Chat apps want an absolute image URL, so these need the site's address."""
    base = url if url.endswith("/") else url + "/"
    w, h = size
    return (
        f'<meta property="og:url" content="{html.escape(base, quote=True)}">\n'
        f'<meta property="og:type" content="website">\n'
        f'<meta property="og:image" content="{html.escape(base + preview, quote=True)}">\n'
        f'<meta property="og:image:width" content="{w}">\n'
        f'<meta property="og:image:height" content="{h}">\n'
        f'<meta name="twitter:card" content="summary_large_image">\n'
    )


def render(caption, date, note, details, src, size, aspect, url, preview, preview_size):
    """Fill template.html in one pass, so no inserted text is ever read as a placeholder.

    Text goes in HTML-escaped. The data block is JSON with `<`, `>` and `&` as
    unicode escapes, so nothing in it can close the script element or open a comment.
    """
    w, h = size
    esc = lambda t: html.escape(t, quote=True)
    data = json.dumps({
        "caption": caption, "date": date, "src": src, "w": w, "h": h,
        "aspect": aspect, "details": details,
    }).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    fills = {
        "__TITLE__": esc(caption),
        "__DESCRIPTION__": esc(date or "A polaroid"),
        "__SHARE_META__": share_tags(url, preview, preview_size) if url else "",
        "__ASPECT__": "1" if aspect == "square" else str(round(w / h, 4)),
        "__SRC__": src,
        "__W__": str(w),
        "__H__": str(h),
        "__ALT__": esc(caption),
        "__CAPTION__": html.escape(caption),
        "__DATE_HTML__": f'<time class="date">{html.escape(date)}</time>' if date else "",
        "__NOTE_HTML__": f'<p class="note">{html.escape(note)}</p>' if note else "",
        "__DATA__": data,
    }
    tokens = re.compile("|".join(map(re.escape, fills)))
    return tokens.sub(lambda m: fills[m.group(0)], TEMPLATE.read_text())


def build(photo, caption, out, date=None, original=False, url=None, note=None, extra=(), camera=True):
    item_id = mossbear_id(photo)
    caption_source = "given"
    if not caption:
        if not item_id:
            fail("a local photo needs --caption")
        caption, caption_source = fetch_description(item_id), "description"
        if not caption:
            fail(f"photo {item_id} has no description to caption it with; pass --caption")
    if item_id:
        raw = fetch_part(item_id)
        # The display copy carries no camera details, so read them from the
        # original in memory. Only the allowlisted tags are kept; the original
        # is never written anywhere.
        cam = camera_details(fetch_part(item_id, "original")) if camera else {}
    else:
        path = Path(photo).expanduser()
        if not path.is_file():
            fail(f"{photo} is neither a file nor a Mossbear photo id")
        raw = path.read_bytes()
        cam = camera_details(raw) if camera else {}
    data, size, ext = clean(raw)
    if not size:
        fail("could not read the photo's dimensions")

    out = Path(out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    for old in [*out.glob("photo.*"), *out.glob("preview.*")]:
        old.unlink()
    (out / f"photo.{ext}").write_bytes(data)

    # The link-preview image: a Mossbear photo's thumb (≤512px, small enough for
    # every chat app), otherwise the photo itself.
    preview, preview_size = f"photo.{ext}", size
    if item_id:
        thumb, thumb_size, thumb_ext = clean(fetch_part(item_id, "thumb"))
        preview, preview_size = f"preview.{thumb_ext}", thumb_size
        (out / preview).write_bytes(thumb)

    caption = caption.strip()
    details = detail_rows(cam, size)
    for line in extra:
        label, _, text = line.partition("=")
        if label.strip() and text.strip():
            details.insert(len(details) - 1, (label.strip(), text.strip()))
    page = render(caption, date, note, details, f"photo.{ext}", size,
                  "original" if original else "square", url, preview, preview_size)
    (out / "index.html").write_text(page)
    print(json.dumps({
        "ok": True,
        "dir": str(out),
        "photo": f"photo.{ext}",
        "width": size[0],
        "height": size[1],
        "bytes": len(data),
        "strippedBytes": len(raw) - len(data),
        "preview": preview,
        "shareTags": bool(url),
        "caption": caption,
        "captionSource": caption_source,
        "back": dict(details),
        "source": f"mossbear:{item_id}" if item_id else "file",
    }, indent=2))


def main(argv):
    parser = argparse.ArgumentParser(prog="polaroid.py", description="Build a polaroid page from a photo and a caption.")
    parser.add_argument("photo", help="local .jpg/.png, or a Mossbear photo id or URL")
    parser.add_argument("--caption", help="starting caption, which viewers can change on their own screen; "
                        "defaults to a Mossbear photo's description")
    parser.add_argument("--out", required=True, help="folder to write index.html and the photo into")
    parser.add_argument("--date", help="small line under the caption, e.g. 'October 2026'")
    parser.add_argument("--note", help="a handwritten note on the back of the card")
    parser.add_argument("--meta", action="append", default=[], metavar="LABEL=TEXT",
                        help="an extra line on the back, e.g. 'Place=Lisbon'; repeatable")
    parser.add_argument("--no-camera", dest="camera", action="store_false",
                        help="leave camera, lens, exposure and date taken off the back")
    parser.add_argument("--original", action="store_true",
                        help="start at the photo's own shape instead of the square polaroid print")
    parser.add_argument("--url", help="the site's live address, for link-preview tags (second pass, after the first deploy)")
    a = parser.parse_args(argv)
    if a.caption is not None and not a.caption.strip():
        fail("the caption is empty")
    build(a.photo, a.caption, a.out, a.date, a.original, a.url, a.note, a.meta, a.camera)


if __name__ == "__main__":
    main(sys.argv[1:])
