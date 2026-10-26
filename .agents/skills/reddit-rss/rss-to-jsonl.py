#!/usr/bin/env python3
"""Flatten a Reddit Atom feed to JSONL — one record per line.

Reddit serves .rss as Atom, not RSS 2.0. Every field this emits comes from
the feed itself; nothing is inferred. Fields Reddit does not put in the feed
(score, comment count) are absent rather than guessed — see SKILL.md.

Usage:
    rss-to-jsonl.py feed.xml [feed2.xml ...] > posts.jsonl
    curl ... | rss-to-jsonl.py - > posts.jsonl
"""

import html
import json
import re
import sys
import xml.etree.ElementTree as ET

ATOM = "{http://www.w3.org/2005/Atom}"

# Reddit's <content> always ends with the same trailer: "submitted by /u/x [link] [comments]".
# For a self post the body HTML precedes it. Strip it as plain text, after tags are gone --
# ElementTree has already decoded the entities once, so matching against markup is brittle.
# A user feed adds "to r/<sub>"; a link post has "[link]", a self post does not.
STUB = re.compile(
    r"\s*submitted by\s*/u/\S+\s*(?:to\s+r/\S+\s*)?(?:\[link\]\s*)?\[comments\]\s*$",
    re.I | re.S,
)
TAGS = re.compile(r"<[^>]+>")
# Reddit marks a link post's target with the anchor text "[link]"; nothing else does.
LINK_ANCHOR = re.compile(r'<a\s+href="([^"]+)"[^>]*>\s*\[link\]\s*</a>', re.I)


def text_of(node, path):
    found = node.find(path)
    return found.text if found is not None and found.text else None


def strip_html(raw):
    """Drop tags, decode entities, then strip Reddit's fixed trailer as plain text."""
    if not raw:
        return None
    out = TAGS.sub(" ", raw)
    out = html.unescape(out)
    out = re.sub(r"[ \t\u00a0]+", " ", out)
    out = STUB.sub("", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out or None


def outbound_link(raw):
    """The URL a link post points at, taken only from the trailer's [link] anchor.

    Scanning the whole content for the first non-Reddit href is wrong: a self
    post's body link (a gist, a repro) and a comment's body link both match it,
    and neither is the post's target. Reddit marks the real one by anchor text.
    """
    if not raw:
        return None
    match = LINK_ANCHOR.search(raw)
    return html.unescape(match.group(1)) if match else None


def parse(path):
    raw = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    if not raw.strip():
        print(f"warn: {path} is empty — a block returns an empty body", file=sys.stderr)
        return
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        print(f"warn: {path} is not XML ({exc}) — likely an HTML block page", file=sys.stderr)
        return

    if root.tag != f"{ATOM}feed":
        print(f"warn: {path} is XML but not an Atom feed (root <{root.tag}>) -- likely a block page", file=sys.stderr)
        return
    if root.find(f"{ATOM}entry") is None:
        print(f"warn: {path} is an Atom feed with no entries -- empty listing, or a block", file=sys.stderr)
        return

    subreddit = None
    cat = root.find(f"{ATOM}category")
    if cat is not None:
        subreddit = cat.get("term")

    for entry in root.iter(f"{ATOM}entry"):
        content = text_of(entry, f"{ATOM}content")
        link = entry.find(f"{ATOM}link")
        author = entry.find(f"{ATOM}author")
        ecat = entry.find(f"{ATOM}category")

        body = strip_html(content)
        permalink = link.get("href") if link is not None else None
        url = outbound_link(content)

        yield {
            "id": text_of(entry, f"{ATOM}id"),
            "subreddit": (ecat.get("term") if ecat is not None else None) or subreddit,
            "title": text_of(entry, f"{ATOM}title"),
            "author": text_of(author, f"{ATOM}name") if author is not None else None,
            "published": text_of(entry, f"{ATOM}published"),
            "updated": text_of(entry, f"{ATOM}updated"),
            "permalink": permalink,
            # The target of the trailer's [link] anchor, or None when the entry
            # has none. Independent of selftext: a post can carry both body text
            # and an outbound link, and 24 of 118 captured records do.
            "url": None if url == permalink else url,
            # Whatever body text the entry carries -- a self post's text, a
            # comment's text, or a link post's description. None when there is
            # none. Does not imply anything about `url`.
            "selftext": body or None,
        }


def main():
    paths = sys.argv[1:] or ["-"]
    seen, n = set(), 0
    for path in paths:
        for row in parse(path):
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            print(json.dumps(row, ensure_ascii=False))
            n += 1
    print(f"{n} record(s) from {len(paths)} feed(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
