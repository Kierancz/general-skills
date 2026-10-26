#!/usr/bin/env python3
"""Find existing agent skills for a task. Read-only: queries indexes, never installs or runs a candidate.

Sources:
  local     SKILL.md files under ~/.claude/skills, ~/.agents/skills, ~/.claude/plugins, plus
            marketplace.json entries and the cached Claude plugin directory
  skillssh  the skills.sh search API (the index behind `npx skills`)
  github    `gh search code --filename SKILL.md` and `gh search repos` (needs an authed gh)

Prints one JSON object per candidate, best match first within each source.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HOME = Path.home()
LOCAL_SKILL_DIRS = [HOME / ".claude/skills", HOME / ".agents/skills", HOME / ".claude/plugins"]
PLUGINS = HOME / ".claude/plugins"
UA = "skill-search/1 (+https://github.com/Kierancz/general-skills)"


def frontmatter(text):
    """Parse name/description from SKILL.md frontmatter without a YAML dependency."""
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    out, lines, i = {}, m.group(1).splitlines(), 0
    while i < len(lines):
        km = re.match(r"^([A-Za-z_-]+):\s*(.*)$", lines[i])
        i += 1
        if not km:
            continue
        key, val = km.group(1), km.group(2).strip()
        if val in (">", "|", ">-", "|-", ""):
            block = []
            while i < len(lines) and (lines[i].startswith(" ") or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            val = " ".join(b for b in block if b)
        elif val[:1] == "'" and val.endswith("'"):
            val = val[1:-1].replace("''", "'")
        elif val[:1] == '"' and val.endswith('"'):
            val = val[1:-1].replace('\\"', '"')
        out[key] = val
    return out


def score(terms, *fields):
    """Zero unless most terms appear, so one common word ("organize") is not a match."""
    hay = " ".join(f or "" for f in fields).lower()
    found = [t for t in terms if t in hay]
    if len(found) * 2 <= len(terms):
        return 0
    return sum(hay.count(t) for t in found) + (5 if len(found) == len(terms) else 0)


def search_local(terms, limit):
    hits, seen = [], set()
    for root in LOCAL_SKILL_DIRS:
        if not root.exists():
            continue
        for md in root.rglob("SKILL.md"):
            try:
                real = md.resolve()
                if real in seen:
                    continue
                seen.add(real)
                fm = frontmatter(md.read_text(errors="replace")[:8000])
            except OSError:
                continue
            s = score(terms, fm.get("name"), fm.get("description"), md.parent.name)
            if s:
                hits.append({"source": "local", "score": s, "name": fm.get("name") or md.parent.name,
                             "description": fm.get("description", ""), "location": str(md.parent),
                             "install": "already on this machine"})
    for mp in PLUGINS.glob("marketplaces/*/.claude-plugin/marketplace.json"):
        try:
            data = json.loads(mp.read_text())
        except (OSError, ValueError):
            continue
        market = data.get("name") or mp.parent.parent.name
        for p in data.get("plugins", []):
            s = score(terms, p.get("name"), p.get("description"), p.get("category"))
            if s:
                src = p.get("source")
                url = src.get("url") or src.get("repo") if isinstance(src, dict) else src
                hits.append({"source": "marketplace", "score": s, "name": p.get("name"),
                             "description": p.get("description", ""), "location": url or str(mp),
                             "install": f"claude plugin install {p.get('name')}@{market}"})
    cache = PLUGINS / "plugin-directory-cache-v2.json"
    if cache.exists():
        try:
            listings = json.loads(cache.read_text()).get("listings", [])
        except ValueError:
            listings = []
        for p in listings:
            s = score(terms, p.get("name"), p.get("summary"))
            if s:
                repo = ((p.get("source") or {}).get("repository") or {}).get("url")
                hits.append({"source": "plugin-directory", "score": s, "name": p.get("name"),
                             "description": p.get("summary", ""), "location": repo,
                             "install": "Claude plugin directory (/plugin in Claude Code)"})
    hits.sort(key=lambda h: -h["score"])
    return hits[:limit]


def search_skillssh(query, limit):
    url = "https://skills.sh/api/search?" + urllib.parse.urlencode({"q": query, "limit": limit})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    return [{"source": "skills.sh", "name": s["name"], "installs": s.get("installs"),
             "location": f"https://skills.sh/{s['id']}", "repo": f"https://github.com/{s['source']}",
             "install": f"npx skills add {s['source']} --skill {s['skillId']}"}
            for s in data.get("skills", [])]


def gh(*args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    if out.returncode:
        raise RuntimeError(out.stderr.strip() or f"gh exited {out.returncode}")
    return out.stdout


def install_hint(repo, path):
    folder = Path(path).parent
    if str(folder) == ".":
        return f"npx skills add {repo}, or clone the repo; the skill is the repo root"
    return f"npx skills add {repo} --skill {folder.name}, or copy {folder}/"


def search_github(query, limit, describe):
    hits = []
    code = json.loads(gh("search", "code", query, "--filename", "SKILL.md", "--limit", str(limit),
                         "--json", "repository,path,url"))
    for i, c in enumerate(code):
        repo = c["repository"]["nameWithOwner"]
        h = {"source": "github-skill", "name": Path(c["path"]).parent.name or repo, "location": c["url"],
             "install": install_hint(repo, c["path"])}
        if i < describe:
            try:
                raw = gh("api", f"repos/{repo}/contents/{c['path']}", "-H", "Accept: application/vnd.github.raw")
                fm = frontmatter(raw)
                h["name"], h["description"] = fm.get("name", h["name"]), fm.get("description", "")
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
        hits.append(h)
    repos = json.loads(gh("search", "repos", query, "skills", "--limit", str(limit), "--sort", "stars",
                          "--json", "fullName,description,stargazersCount,url,license,updatedAt"))
    for r in repos:
        hits.append({"source": "github-repo", "name": r["fullName"], "description": r.get("description") or "",
                     "stars": r.get("stargazersCount"), "license": (r.get("license") or {}).get("key"),
                     "updated": r.get("updatedAt"), "location": r["url"],
                     "install": f"see what it holds: search.py --list-repo {r['fullName']}"})
    return hits


def list_repo(repo, limit):
    """Every SKILL.md in a GitHub repo, read through the API. The read-only stand-in for `npx skills add --list`."""
    branch = json.loads(gh("api", f"repos/{repo}"))["default_branch"]
    tree = json.loads(gh("api", f"repos/{repo}/git/trees/{branch}?recursive=1"))
    paths = [t["path"] for t in tree.get("tree", []) if Path(t["path"]).name == "SKILL.md"]
    if tree.get("truncated"):
        print(f"warn: {repo} tree truncated by the API; some skills may be missing", file=sys.stderr)
    hits = []
    for path in paths[:limit]:
        h = {"source": "github-skill", "name": Path(path).parent.name or repo,
             "location": f"https://github.com/{repo}/blob/{branch}/{path}", "install": install_hint(repo, path)}
        try:
            fm = frontmatter(gh("api", f"repos/{repo}/contents/{path}?ref={branch}",
                                "-H", "Accept: application/vnd.github.raw"))
            h["name"], h["description"] = fm.get("name", h["name"]), fm.get("description", "")
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
        hits.append(h)
    if len(paths) > limit:
        print(f"note: {len(paths)} SKILL.md files, showed {limit}; raise --limit for more", file=sys.stderr)
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", nargs="?", help="a few task words, e.g. 'organize photos exif'")
    ap.add_argument("--list-repo", metavar="OWNER/REPO", help="list the skills in one GitHub repo instead")
    ap.add_argument("--sources", default="local,skillssh,github", help="comma-separated subset")
    ap.add_argument("--limit", type=int, default=10, help="results per source")
    ap.add_argument("--describe", type=int, default=5,
                    help="fetch frontmatter for the first N GitHub code hits (one API call each)")
    args = ap.parse_args()
    if args.list_repo:
        for hit in list_repo(args.list_repo, max(args.limit, 30)):
            print(json.dumps(hit, ensure_ascii=False))
        return
    if not args.query:
        ap.error("give a query or --list-repo")
    # crude stemming: "photos" and "photo" should match each other
    terms = [t.lower().rstrip("s") for t in args.query.split() if len(t) > 2] or [args.query.lower()]

    runners = {"local": lambda: search_local(terms, args.limit),
               "skillssh": lambda: search_skillssh(args.query, args.limit),
               "github": lambda: search_github(args.query, args.limit, args.describe)}
    for name in args.sources.split(","):
        if name == "github" and not shutil.which("gh"):
            print("skip github: gh not installed", file=sys.stderr)
            continue
        try:
            for hit in runners[name]():
                print(json.dumps(hit, ensure_ascii=False))
        except KeyError:
            print(f"unknown source: {name}", file=sys.stderr)
        except Exception as e:  # one dead source should not hide the others
            print(f"{name} failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
