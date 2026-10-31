#!/usr/bin/env python3
"""Turn a screenshot (a chat, a post, a photo with words in it) into a small
self-contained HTML page and a Markdown twin.

  screenshot_page.py fetch IMAGE --out DIR
  screenshot_page.py build SPEC.json --out DIR

`fetch` takes a local .jpg/.png, or a Mossbear photo by id or artifact URL
(…/artifact/<id>), and writes DIR/source.<ext> with every metadata block
stripped (EXIF, XMP, text chunks), so a phone's GPS position cannot ride along.
It prints the size and, for a Mossbear photo, its description.

`build` reads a spec the agent wrote after looking at the image (the shape is
in SKILL.md) and writes:

  DIR/index.html  one file, no network: the image is inlined once and every
                  picture inside it is a CSS crop of that one copy
  DIR/page.md     the same content as Markdown, for agents and plain reading
  DIR/images/     the crops as files, when Pillow is installed (Markdown links
                  them; without Pillow it describes them instead)

Both commands print one JSON object. Standard library only; Pillow optional.
"""

import argparse
import base64
import html
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_DASHBOARD = "https://app.mossbear.io"
TEMPLATE = Path(__file__).with_name("template.html")
ID = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
KINDS = {"chat", "post", "document", "photo", "other"}
BLOCK_TYPES = {"message", "divider", "system", "heading", "text", "list", "quote", "code", "image"}
SIDES = {"left", "right"}
# A friendly, readable palette for avatars; picked by participant order.
AVATAR_COLOURS = ["#2f9e6b", "#e0703d", "#5b6ee1", "#c2457a", "#2a8fb8", "#a0782a", "#7a53c9", "#3f8f3a"]


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


# ── getting the image ────────────────────────────────────────────────────────

def mossbear_id(image):
    """The artifact id in an id or a dashboard URL, or None for a local path."""
    if Path(image).expanduser().exists():
        return None
    m = re.search(r"[?&]note=([A-Za-z0-9_-]+)", image) or re.search(r"/artifact/([A-Za-z0-9_-]+)", image)
    if m:
        return m.group(1)
    return image if ID.match(image) else None


def api_get(path):
    """GET a Mossbear dashboard API path with the credential the CLI already has."""
    try:
        config = json.loads((Path.home() / ".mossbear" / "config.json").read_text())
    except (OSError, ValueError):
        config = {}
    token = os.environ.get("MOSSBEAR_TOKEN", "").strip() or config.get("token")
    if not token:
        fail("no Mossbear credential here: run `mossbear login`, or pull the photo to disk and pass its path")
    base = (os.environ.get("MOSSBEAR_DASHBOARD_URL", "").strip() or config.get("dashboardUrl") or DEFAULT_DASHBOARD).rstrip("/")
    req = urllib.request.Request(f"{base}{path}")
    req.add_header("Authorization", f"Bearer {token}")
    # Cloudflare in front of the dashboard refuses urllib's default User-Agent (error 1010).
    req.add_header("User-Agent", "screenshot-page-skill/1")
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def fetch_mossbear(item_id):
    """The display copy of a Mossbear photo and its description (or None)."""
    try:
        data = api_get(f"/api/v1/artifacts/{item_id}/assets/display")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            fail(f"no photo {item_id} in this Mossbear account (it may be a text note, or deleted)")
        fail(f"fetching photo {item_id} -> HTTP {err.code}")
    except urllib.error.URLError as err:
        fail(f"fetching photo {item_id}: {err.reason}")
    description = None
    try:
        artifact = json.loads(api_get(f"/api/v1/artifacts/{item_id}")).get("artifact") or {}
        if isinstance(artifact.get("description"), str):
            description = artifact["description"].strip() or None
    except (urllib.error.URLError, ValueError):
        pass  # the description is a nicety; the image is what matters
    return data, description


# ── stripping metadata ───────────────────────────────────────────────────────

# Segments that draw the image. Everything else (EXIF, XMP, comments, maker
# notes) is dropped. Orientation is the one EXIF field that matters for display,
# and is re-written on its own.
JPEG_KEEP = {
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,  # frame headers
    0xC4, 0xCC, 0xDB, 0xDD,  # Huffman/arithmetic tables, quantization tables, restart interval
    0xE0, 0xE2, 0xEE,  # JFIF, ICC colour profile, Adobe colour transform
}
PNG_KEEP = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT"}


def exif_orientation(segment):
    """The Orientation tag (1-8) of an EXIF APP1 segment, or 1."""
    body = segment[4:]
    if body[:6] != b"Exif\x00\x00" or len(body) < 14:
        return 1
    tiff = body[6:]
    endian = "<" if tiff[:2] == b"II" else ">"
    try:
        offset = struct.unpack(endian + "I", tiff[4:8])[0]
        count = struct.unpack(endian + "H", tiff[offset:offset + 2])[0]
        for k in range(count):
            entry = tiff[offset + 2 + 12 * k: offset + 14 + 12 * k]
            if struct.unpack(endian + "H", entry[:2])[0] == 0x0112:
                value = struct.unpack(endian + "H", entry[8:10])[0]
                return value if 1 <= value <= 8 else 1
    except struct.error:
        pass
    return 1


def orientation_only(value):
    """A minimal EXIF APP1 segment holding nothing but Orientation."""
    tiff = b"MM\x00\x2a\x00\x00\x00\x08" + struct.pack(">H", 1) + struct.pack(">HHIHH", 0x0112, 3, 1, value, 0) + b"\x00\x00\x00\x00"
    body = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body


def strip_jpeg(data):
    out, i, size, orientation, n = bytearray(b"\xff\xd8"), 2, None, 1, len(data)
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
            # Scan header, then entropy-coded data up to the next real marker.
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
        if orientation >= 5 and size:  # a quarter turn: displayed width and height swap
            size = (size[1], size[0])
    return bytes(out), size


def strip_png(data):
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
    fail("only JPEG and PNG images are supported; convert HEIC or WebP to PNG first")


def cmd_fetch(image, out):
    item_id = mossbear_id(image)
    description = None
    if item_id:
        raw, description = fetch_mossbear(item_id)
    else:
        path = Path(image).expanduser()
        if not path.is_file():
            fail(f"no file at {path}, and it is not a Mossbear id or artifact link")
        raw = path.read_bytes()
    data, size, ext = clean(raw)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("source.*"):
        old.unlink()
    dest = out / f"source.{ext}"
    dest.write_bytes(data)
    print(json.dumps({
        "ok": True,
        "source": str(dest),
        "mossbearId": item_id,
        "width": size[0] if size else None,
        "height": size[1] if size else None,
        "strippedBytes": len(raw) - len(data),
        "description": description,
    }, indent=2))


# ── the spec ─────────────────────────────────────────────────────────────────

def check_box(box, where):
    if box is None:
        return None
    if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
        fail(f"{where}: box must be [x, y, width, height] as fractions of the image (0-1)")
    x, y, w, h = (float(v) for v in box)
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.001 and y + h <= 1.001):
        fail(f"{where}: box {box} falls outside the image; every value is a fraction from 0 to 1")
    return [x, y, min(w, 1 - x), min(h, 1 - y)]


def load_spec(path):
    try:
        spec = json.loads(Path(path).read_text())
    except (OSError, ValueError) as err:
        fail(f"reading the spec: {err}")
    if not isinstance(spec, dict):
        fail("the spec must be a JSON object")
    if not isinstance(spec.get("title"), str) or not spec["title"].strip():
        fail("the spec needs a title")
    kind = spec.setdefault("kind", "other")
    if kind not in KINDS:
        fail(f"kind must be one of {sorted(KINDS)}")
    people = spec.setdefault("participants", [])
    ids = set()
    for k, p in enumerate(people):
        if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not isinstance(p.get("name"), str):
            fail(f"participants[{k}] needs an id and a name")
        p.setdefault("side", "left")
        if p["side"] not in SIDES:
            fail(f"participants[{k}].side must be left or right")
        p["colour"] = AVATAR_COLOURS[k % len(AVATAR_COLOURS)]
        ids.add(p["id"])
    blocks = spec.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        fail("the spec needs a non-empty blocks list")
    for k, b in enumerate(blocks):
        where = f"blocks[{k}]"
        if not isinstance(b, dict) or b.get("type") not in BLOCK_TYPES:
            fail(f"{where}: type must be one of {sorted(BLOCK_TYPES)}")
        if b["type"] == "message":
            if b.get("from") not in ids:
                fail(f"{where}: from must be a participant id ({sorted(ids) or 'add participants first'})")
            if not b.get("text") and not b.get("image"):
                fail(f"{where}: a message needs text, an image, or both")
        elif b["type"] == "list":
            if not isinstance(b.get("items"), list) or not b["items"]:
                fail(f"{where}: a list needs items")
        elif b["type"] == "image":
            b["box"] = check_box(b.get("box"), where)
            if not b["box"] or not b.get("alt"):
                fail(f"{where}: an image needs a box and alt text")
        elif not isinstance(b.get("text"), str):
            fail(f"{where}: needs text")
        if b["type"] == "message" and b.get("image"):
            img = b["image"]
            if not isinstance(img, dict):
                fail(f"{where}.image must be an object with box and alt")
            img["box"] = check_box(img.get("box"), f"{where}.image")
            if not img["box"] or not img.get("alt"):
                fail(f"{where}.image needs a box and alt text")
    return spec


def find_source(out, spec_path, spec):
    named = spec.get("image")
    candidates = [Path(named).expanduser()] if named else []
    if named and not candidates[0].is_absolute():
        candidates.insert(0, Path(spec_path).parent / named)
    candidates += sorted(out.glob("source.*"))
    for c in candidates:
        if c.is_file():
            return c
    fail("no source image: run `fetch` into the same --out folder first, or set \"image\" in the spec")


def image_size(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    _, size = strip_jpeg(data)
    if not size:
        fail("could not read the image size")
    return size


# ── rendering ────────────────────────────────────────────────────────────────

def esc(text):
    return html.escape(str(text), quote=True)


def inline(text):
    """Escaped text with line breaks kept and bare links made clickable."""
    out = esc(text)
    out = re.sub(r"(https?://[^\s<]+[^\s<.,;:!?)\]'\"])", r'<a href="\1" rel="noopener noreferrer">\1</a>', out)
    return out.replace("\n", "<br>")


def crop_style(box, size):
    x, y, w, h = box
    pos_x = 0 if w >= 1 else x / (1 - w) * 100
    pos_y = 0 if h >= 1 else y / (1 - h) * 100
    ratio = (w * size[0]) / (h * size[1])
    return (f"aspect-ratio:{ratio:.4f};background-size:{100 / w:.3f}% {100 / h:.3f}%;"
            f"background-position:{pos_x:.3f}% {pos_y:.3f}%")


def crop_html(img, size, n, extra=""):
    caption = f'<figcaption>{inline(img["caption"])}</figcaption>' if img.get("caption") else ""
    return (f'<figure class="pic{extra}" data-n="{n}"><div class="crop src" role="img" aria-label="{esc(img["alt"])}" '
            f'style="{crop_style(img["box"], size)}"></div>{caption}</figure>')


def initials(name):
    parts = [p for p in re.split(r"\s+", name.strip()) if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper() if parts[0].isascii() else parts[0][:1]
    return (parts[0][:1] + parts[-1][:1]).upper()


def render_blocks(spec, size):
    people = {p["id"]: p for p in spec["participants"]}
    out, n, prev = [], 0, None
    for b in spec["blocks"]:
        t = b["type"]
        if t == "message":
            p = people[b["from"]]
            first = prev is None or prev.get("type") != "message" or prev.get("from") != b["from"]
            inner = []
            if b.get("replyTo"):
                inner.append(f'<div class="reply">{inline(b["replyTo"])}</div>')
            if b.get("image"):
                n += 1
                inner.append(crop_html(b["image"], size, n))
            if b.get("text"):
                inner.append(f'<div class="text">{inline(b["text"])}</div>')
            meta = []
            if b.get("time"):
                meta.append(f'<time>{esc(b["time"])}</time>')
            if b.get("edited"):
                meta.append("<span>edited</span>")
            if meta:
                inner.append(f'<div class="meta">{" · ".join(meta)}</div>')
            reacts = "".join(f"<span>{esc(r)}</span>" for r in b.get("reactions") or [])
            if reacts:
                inner.append(f'<div class="reacts">{reacts}</div>')
            avatar = (f'<span class="avatar" style="--c:{p["colour"]}" aria-hidden="true">{esc(initials(p["name"]))}</span>'
                      if first else '<span class="avatar ghost" aria-hidden="true"></span>')
            name = f'<div class="who" style="--c:{p["colour"]}">{esc(p["name"])}</div>' if first else ""
            out.append(f'<div class="msg {p["side"]}{" first" if first else ""}">{avatar}<div class="stack">{name}'
                       f'<div class="bubble{"" if b.get("text") else " bare"}" style="--c:{p["colour"]}"><span class="sr">{esc(p["name"])}: </span>{"".join(inner)}</div></div></div>')
        elif t == "divider":
            out.append(f'<div class="divider"><span>{inline(b["text"])}</span></div>')
        elif t == "system":
            out.append(f'<p class="system">{inline(b["text"])}</p>')
        elif t == "heading":
            out.append(f'<h2>{inline(b["text"])}</h2>')
        elif t == "text":
            out.append(f'<p class="para">{inline(b["text"])}</p>')
        elif t == "list":
            tag = "ol" if b.get("ordered") else "ul"
            items = "".join(f"<li>{inline(i)}</li>" for i in b["items"])
            out.append(f'<{tag} class="list">{items}</{tag}>')
        elif t == "quote":
            who = f'<cite>{esc(b["by"])}</cite>' if b.get("by") else ""
            out.append(f'<blockquote>{inline(b["text"])}{who}</blockquote>')
        elif t == "code":
            out.append(f'<pre><code>{esc(b["text"])}</code></pre>')
        elif t == "image":
            n += 1
            out.append(crop_html(b, size, n, " solo"))
        prev = b
    return "\n".join(out)


def md_text(text):
    # Keep the words as written; only stop stray HTML from rendering.
    return str(text).replace("<", "&lt;")


def md_quote(text):
    return "\n".join("> " + line if line else ">" for line in md_text(text).split("\n"))


def render_markdown(spec, crops):
    people = {p["id"]: p for p in spec["participants"]}
    lines = ["---", f"title: {json.dumps(spec['title'], ensure_ascii=False)}", f"kind: {spec['kind']}"]
    if spec.get("source"):
        lines.append(f"source: {json.dumps(spec['source'], ensure_ascii=False)}")
    if spec.get("date"):
        lines.append(f"date: {json.dumps(spec['date'], ensure_ascii=False)}")
    if spec["participants"]:
        lines.append("participants:")
        lines += [f"  - {json.dumps(p['name'], ensure_ascii=False)}" for p in spec["participants"]]
    lines += ["transcribed-from: screenshot", "---", "", f"# {md_text(spec['title'])}", ""]
    if spec.get("summary"):
        lines += [md_text(spec["summary"]), ""]
    n = 0

    def picture(img):
        nonlocal n
        n += 1
        alt = md_text(img["alt"]).replace("]", ")").replace("[", "(")
        if n in crops:
            return f"![{alt}]({crops[n]})"
        return f"*[image: {alt}]*"

    for b in spec["blocks"]:
        t = b["type"]
        if t == "message":
            p = people[b["from"]]
            head = f"**{md_text(p['name'])}**"
            if b.get("time"):
                head += f" · {md_text(b['time'])}"
            if b.get("edited"):
                head += " · edited"
            body = []
            if b.get("replyTo"):
                body.append(f"↪ *replying to: {md_text(b['replyTo'])}*")
            if b.get("image"):
                body.append(picture(b["image"]))
                if b["image"].get("caption"):
                    body.append(f"*{md_text(b['image']['caption'])}*")
            if b.get("text"):
                body.append(md_text(b["text"]))
            if b.get("reactions"):
                body.append("Reactions: " + " ".join(md_text(r) for r in b["reactions"]))
            lines += [head, md_quote("\n\n".join(body)), ""]
        elif t == "divider":
            lines += [f"— {md_text(b['text'])} —", ""]
        elif t == "system":
            lines += [f"*{md_text(b['text'])}*", ""]
        elif t == "heading":
            lines += [f"## {md_text(b['text'])}", ""]
        elif t == "text":
            lines += [md_text(b["text"]), ""]
        elif t == "list":
            lines += [(f"{k + 1}. " if b.get("ordered") else "- ") + md_text(i) for k, i in enumerate(b["items"])] + [""]
        elif t == "quote":
            lines += [md_quote(b["text"] + (f"\n— {b['by']}" if b.get("by") else "")), ""]
        elif t == "code":
            fence = "````" if "```" in b["text"] else "```"
            lines += [fence + (b.get("lang") or ""), b["text"], fence, ""]
        elif t == "image":
            lines.append(picture(b))
            if b.get("caption"):
                lines.append(f"*{md_text(b['caption'])}*")
            lines.append("")
    if spec.get("unclear"):
        lines += ["## Couldn't read", ""] + [f"- {md_text(u)}" for u in spec["unclear"]] + [""]
    return "\n".join(lines).rstrip() + "\n"


def write_crops(spec, source, out):
    """Crop each picture to its own file with Pillow; {} when Pillow is missing."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return {}
    boxes = []
    for b in spec["blocks"]:
        if b["type"] == "image":
            boxes.append(b["box"])
        elif b["type"] == "message" and b.get("image"):
            boxes.append(b["image"]["box"])
    folder = out / "images"
    if folder.exists():
        for old in folder.glob("*.png"):
            old.unlink()
    if not boxes:
        return {}
    folder.mkdir(exist_ok=True)
    img = ImageOps.exif_transpose(Image.open(source))
    W, H = img.size
    crops = {}
    for k, (x, y, w, h) in enumerate(boxes, start=1):
        part = img.crop((round(x * W), round(y * H), round((x + w) * W), round((y + h) * H)))
        name = f"images/{k}.png"
        part.save(out / name)
        crops[k] = name
    return crops


def cmd_build(spec_path, out):
    spec = load_spec(spec_path)
    out.mkdir(parents=True, exist_ok=True)
    source = find_source(out, spec_path, spec)
    data = source.read_bytes()
    size = image_size(data)
    mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    crops = write_crops(spec, source, out)
    markdown = render_markdown(spec, crops)
    kind_label = {"chat": "chat", "post": "post", "document": "page", "photo": "photo", "other": "screenshot"}[spec["kind"]]
    sub = " · ".join(esc(s) for s in (spec.get("source"), spec.get("date")) if s)
    people = "".join(
        f'<li style="--c:{p["colour"]}"><span class="avatar" aria-hidden="true">{esc(initials(p["name"]))}</span>{esc(p["name"])}</li>'
        for p in spec["participants"])
    unclear = "".join(f"<li>{inline(u)}</li>" for u in spec.get("unclear") or [])
    values = {
        "TITLE": esc(spec["title"]),
        "EMOJI": esc(spec.get("emoji") or {"chat": "💬", "post": "📣", "document": "📄", "photo": "📸"}.get(spec["kind"], "🐻")),
        "KIND": esc(kind_label),
        "SUB": sub,
        "SUMMARY": f'<p class="summary">{inline(spec["summary"])}</p>' if spec.get("summary") else "",
        "PEOPLE": f'<ul class="people" aria-label="Who is in it">{people}</ul>' if people else "",
        "BODY_CLASS": "chat" if spec["kind"] == "chat" else "doc",
        "BLOCKS": render_blocks(spec, size),
        "UNCLEAR": f'<section class="unclear"><h2>Couldn’t read</h2><ul>{unclear}</ul></section>' if unclear else "",
        "ACCENT": esc(spec.get("accent") or "#2f9e6b"),
        "SRC": f"data:{mime};base64,{base64.b64encode(data).decode()}",
        "ORIGINAL": f'<div class="crop src" role="img" aria-label="The original screenshot" style="{crop_style([0, 0, 1, 1], size)}"></div>',
        "MARKDOWN": esc(markdown),
    }
    # One pass, so a transcribed "{{...}}" in the text is never itself replaced.
    page = re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: values.get(m.group(1), m.group(0)), TEMPLATE.read_text())
    (out / "index.html").write_text(page)
    (out / "page.md").write_text(markdown)
    print(json.dumps({
        "ok": True,
        "html": str(out / "index.html"),
        "markdown": str(out / "page.md"),
        "crops": [str(out / c) for c in crops.values()],
        "cropsSkipped": not crops and any(b["type"] == "image" or b.get("image") for b in spec["blocks"]),
        "htmlBytes": len(page.encode()),
    }, indent=2))


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="copy an image (local or Mossbear) to DIR/source.<ext>, metadata stripped")
    f.add_argument("image")
    f.add_argument("--out", required=True, type=Path)
    b = sub.add_parser("build", help="write index.html and page.md from a spec")
    b.add_argument("spec")
    b.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.cmd == "fetch":
        cmd_fetch(args.image, args.out.expanduser())
    else:
        cmd_build(args.spec, args.out.expanduser())


if __name__ == "__main__":
    main(sys.argv[1:])
