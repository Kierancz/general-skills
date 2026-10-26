#!/usr/bin/env python3
"""Publish a static site to here.now and print where it went.

  deploy.py publish PATH [--slug SLUG] [--title TITLE]
  deploy.py login EMAIL
  deploy.py verify EMAIL CODE
  deploy.py claim SLUG

PATH is one .html file (served as index.html) or a folder (served as-is).
Without --slug a new site is created; with it, that site is replaced in
place and keeps its URL. Prints one JSON object on stdout; diagnostics go
to stderr. Standard library only, so it runs anywhere python3 does.

The API key, when there is one, comes from $HERENOW_API_KEY or
~/.herenow/credentials. Without one the publish is anonymous and the site
expires in 24 hours unless claimed. The key is never printed.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://here.now"
CLIENT = "claude-code/deploy-site"
HOME = Path.home() / ".herenow"
CREDENTIALS = HOME / "credentials"
SITES = HOME / "sites.json"  # slug -> claimToken for anonymous sites we created


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def api_key():
    key = os.environ.get("HERENOW_API_KEY", "").strip()
    if not key and CREDENTIALS.is_file():
        key = CREDENTIALS.read_text().strip()
    return key or None


def write_private(path, text):
    HOME.mkdir(mode=0o700, exist_ok=True)
    path.write_text(text)
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def load_sites():
    try:
        return json.loads(SITES.read_text())
    except (OSError, ValueError):
        return {}


def request(method, url, body=None, key=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-HereNow-Client", CLIENT)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode() or "{}"
            return json.loads(text) if raw is None else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:800]
        fail(f"{method} {url.split('?')[0]} -> HTTP {err.code}: {detail}")
    except urllib.error.URLError as err:
        fail(f"{method} {url.split('?')[0]} unreachable: {err.reason}")


def collect(path):
    """Return [(site_path, local_file)] for a file or a folder."""
    root = Path(path).expanduser()
    if root.is_file():
        if root.suffix.lower() not in (".html", ".htm"):
            fail(f"{root} is not an .html file; pass a folder to publish other files")
        return [("index.html", root)]
    if not root.is_dir():
        fail(f"{root} does not exist")
    files = []
    for f in sorted(root.rglob("*")):
        rel = f.relative_to(root).as_posix()
        if f.is_file() and not any(part.startswith(".") and part != ".herenow" for part in rel.split("/")):
            files.append((rel, f))
    if not any(rel == "index.html" for rel, _ in files):
        fail(f"{root} has no index.html at its top level")
    return files


def publish(path, slug=None, title=None):
    key = api_key()
    files = collect(path)
    manifest = []
    for rel, f in files:
        blob = f.read_bytes()
        manifest.append({
            "path": rel,
            "size": len(blob),
            "contentType": mimetypes.guess_type(rel)[0] or "application/octet-stream",
            "hash": hashlib.sha256(blob).hexdigest(),
        })
    body = {"files": manifest}
    if title:
        body["displayName"] = title

    sites = load_sites()
    if slug:
        if key and slug in sites:
            # An anonymous site we made before logging in. here.now authorizes
            # its updates only by claim token, never by API key, so move it into
            # the account first; from then on the key is what authorizes it.
            claim_site(slug, key, sites)
        elif not key:
            if slug not in sites:
                fail(f"no claim token on this machine for {slug}; publish without --slug, or log in and claim it")
            body["claimToken"] = sites[slug]
        created = request("PUT", f"{API}/api/v1/publish/{slug}", body, key)
    else:
        created = request("POST", f"{API}/api/v1/publish", body, key)

    slug = created["slug"]
    if created.get("claimToken"):
        sites[slug] = created["claimToken"]
        write_private(SITES, json.dumps(sites, indent=2))

    upload = created.get("upload") or {}
    local = dict(files)
    for item in upload.get("uploads", []):
        request(item.get("method", "PUT"), item["url"], key=None,
                headers=item.get("headers") or {}, raw=local[item["path"]].read_bytes())

    live = request("POST", f"{API}/api/v1/publish/{slug}/finalize",
                   {"versionId": upload.get("versionId")}, key)
    status = live.get("publishStatus") or created.get("publishStatus") or {}
    out = {
        "ok": True,
        "url": live.get("siteUrl") or created.get("siteUrl"),
        "slug": slug,
        "files": len(manifest),
        "uploaded": len(upload.get("uploads", [])),
        "persistence": status.get("persistence"),
        "expiresAt": status.get("expiresAt") or created.get("expiresAt"),
    }
    if live.get("primaryUrl") and live["primaryUrl"] != out["url"]:
        out["primaryUrl"] = live["primaryUrl"]
    if created.get("claimUrl"):
        out["claimUrl"] = created["claimUrl"]
    print(json.dumps(out, indent=2))


def login(email):
    res = request("POST", f"{API}/api/auth/agent/request-code", {"email": email, "client": "claude-code"})
    print(json.dumps({"ok": True, "sent": res.get("success"), "codeExpiresAt": res.get("expiresAt")}))


def verify(email, code):
    res = request("POST", f"{API}/api/auth/agent/verify-code",
                  {"email": email, "code": code, "keyName": "deploy-site"})
    if not res.get("apiKey"):
        fail("verify returned no API key")
    write_private(CREDENTIALS, res["apiKey"] + "\n")
    print(json.dumps({"ok": True, "email": res.get("email"), "newAccount": res.get("isNewUser"),
                      "savedTo": str(CREDENTIALS)}))


def claim_site(slug, key, sites):
    """Move an anonymous site into the account and forget its claim token. Safe to repeat."""
    res = request("POST", f"{API}/api/v1/publish/{slug}/claim", {"claimToken": sites[slug]}, key)
    del sites[slug]
    write_private(SITES, json.dumps(sites, indent=2))
    return res


def claim(slug):
    key = api_key()
    if not key:
        fail("claiming needs an account; run login and verify first")
    sites = load_sites()
    if slug not in sites:
        fail(f"no claim token on this machine for {slug}; open its claimUrl in a browser instead")
    res = claim_site(slug, key, sites)
    print(json.dumps({"ok": True, "url": res.get("siteUrl"), "slug": slug, "expiresAt": res.get("expiresAt")}))


def main(argv):
    parser = argparse.ArgumentParser(prog="deploy.py", description="Publish a static site to here.now.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish", help="publish an .html file or a folder")
    p.add_argument("path")
    p.add_argument("--slug", help="replace this existing site instead of creating one")
    p.add_argument("--title", help="owner-facing site name")
    sub.add_parser("login", help="email a one-time code").add_argument("email")
    v = sub.add_parser("verify", help="trade the emailed code for an API key")
    v.add_argument("email")
    v.add_argument("code")
    sub.add_parser("claim", help="move an anonymous site into the account").add_argument("slug")
    a = parser.parse_args(argv)
    if a.cmd == "publish":
        publish(a.path, a.slug, a.title)
    elif a.cmd == "login":
        login(a.email)
    elif a.cmd == "verify":
        verify(a.email, a.code)
    else:
        claim(a.slug)


if __name__ == "__main__":
    main(sys.argv[1:])
