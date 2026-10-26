#!/usr/bin/env python3
"""Inventory a skill folder and flag lines worth a human read. Reads files only; runs nothing it finds.

  python3 -I scan.py <skill-dir>            text report
  python3 -I scan.py <skill-dir> --json     machine-readable

A flag is a pointer to a line, not a verdict. A clean scan does not make a skill safe:
read every script it lists, whatever this says.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

SCRIPT_EXT = {".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat",
              ".cmd", ".go", ".rs", ".lua", ".php", ".swift", ".applescript", ".scpt"}
TEXT_EXT = {".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".html", ".css", ".xml", ".csv", ".ini", ".cfg"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}

# (category, regex, why it matters). Kept broad on purpose: a false flag costs one look.
RULES = [
    ("pipe-to-shell", r"(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b", "downloads code and runs it unseen"),
    ("pipe-to-shell", r"(ba|z)?sh\s+<\(\s*(curl|wget)", "downloads code and runs it unseen"),
    ("pipe-to-shell", r"(curl|wget)\b[^\n|]*\|\s*(python3?|node|perl|ruby)\b", "downloads code and runs it unseen"),
    ("pipe-to-shell", r"\biex\b|Invoke-Expression", "runs a string as PowerShell"),
    ("network", r"\b(curl|wget|nc|ncat|scp|rsync|ssh)\b\s", "network or remote access"),
    ("network", r"\b(requests|httpx|aiohttp|urllib\.request|http\.client|socket)\b|\bfetch\(|axios", "network call from code"),
    ("credentials", r"\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\b", "reads or names a secret"),
    ("credentials", r"~?/?\.(ssh|aws|gnupg|netrc|npmrc|pypirc|docker/config|kube/config)\b", "touches a credential store"),
    ("credentials", r"security\s+(find|dump)-|keychain|Login Data|Cookies|cookies\.sqlite|--cookies", "keychain or browser cookies"),
    ("destructive", r"\brm\s+-[a-zA-Z]*[rf]|\bshutil\.rmtree|\bos\.(remove|unlink|rmdir)|\.unlink\(|\bfs\.(rm|unlink)", "deletes files"),
    ("destructive", r"find\b[^\n]*-delete|\bdd\s+if=|\bmkfs|\bshred\b|\btruncate\s+-s", "deletes or overwrites data"),
    ("destructive", r"git\s+(push\s+[^\n]*(-f\b|--force)|reset\s+--hard|clean\s+-[a-z]*f)", "rewrites or drops git history"),
    ("destructive", r"\bmv\s+-f|\bos\.replace|\bshutil\.move", "moves or overwrites files"),
    ("privilege", r"\bsudo\b|chmod\s+(-R\s+)?[0-7]*7[0-7]{2}|chown\s+-R", "elevates or loosens permissions"),
    ("dynamic-exec", r"\beval\s*\(|\beval\s+[\"'$`]|\bexec\(|(?<![.\w])compile\(|os\.system|shell\s*=\s*True|child_process|new Function\(", "runs a constructed string"),
    ("runs-commands", r"\bsubprocess\.|\bPopen\(|\bspawnSync?\(|\bexecSync\(", "starts other programs; check which"),
    ("obfuscation", r"base64\s+(-d|--decode)|b64decode|atob\(|\\x[0-9a-fA-F]{2}(\\x[0-9a-fA-F]{2}){7,}", "decodes hidden content"),
    ("obfuscation", r"[A-Za-z0-9+/]{200,}={0,2}", "long encoded blob"),
    ("installs", r"\b(pip3?|uv|pipx)\s+install|\bnpm\s+(i|install)\b|\bnpx\s|\bbrew\s+install|\bgem\s+install|\bcargo\s+install|\bgo\s+install", "installs software"),
    ("persistence", r"crontab|launchctl|LaunchAgents|systemctl|\.(bash|zsh)rc|\.profile\b|\.bash_profile|autostart", "survives past the session"),
    ("exfil-shape", r"(curl|wget)\b[^\n]*(-d|--data|-F|--upload-file|-T)\b", "sends data out"),
    ("hidden-path", r"/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Z]:\\\\Users\\\\", "hard-coded personal path; not portable"),
    ("hidden-path", r"\.\./\.\./|\bpackages/[a-z-]+/|\bapps/[a-z-]+/|\bsrc/[a-z-]+/", "assumes a particular repo layout"),
]
# Outside code fences in Markdown, only these apply: prose naming `curl` is normal, prose saying `curl ... | sh` is not.
PROSE_CODE_CATEGORIES = {"pipe-to-shell", "hidden-path", "persistence", "prompt-injection"}
# Instructions in prose that try to steer the agent away from the user.
PROSE_RULES = [
    ("prompt-injection", r"ignore (all |any )?(previous|prior|above) instructions|disregard (the|your) (system|previous)", "tries to override the agent's instructions"),
    ("prompt-injection", r"(do not|don't|never) (tell|inform|show|mention)[^\n.]{0,30}(the )?user|without (asking|telling|confirming with|notifying) (the )?user", "asks the agent to hide actions or skip consent"),
    ("prompt-injection", r"\b(silently|quietly|secretly)\s+(run|install|delete|remove|send|upload|post|modify|change|overwrite|write|commit|push|add)", "asks for unannounced actions"),
]
LICENSE_HINTS = [("MIT", r"\bMIT License\b|Permission is hereby granted, free of charge"),
                 ("Apache-2.0", r"Apache License,?\s+Version 2\.0"),
                 ("GPL", r"GNU (Affero |Lesser )?General Public License"),
                 ("BSD", r"Redistribution and use in source and binary forms"),
                 ("MPL-2.0", r"Mozilla Public License"),
                 ("Unlicense", r"This is free and unencumbered software"),
                 ("CC", r"Creative Commons")]


def frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None
    out, key = {}, None
    for line in m.group(1).splitlines():
        km = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
        if km:
            key, val = km.group(1), km.group(2).strip()
            if val[:1] in "'\"" and val[-1:] == val[:1]:
                val = val[1:-1].replace("''", "'")
            out[key] = "" if val in (">", "|", ">-", "|-") else val
        elif key and line.startswith(" "):
            out[key] = (out[key] + " " + line.strip()).strip()
    return out


def is_binary(path):
    try:
        return b"\0" in path.open("rb").read(4096)
    except OSError:
        return True


def kind(path):
    if path.suffix.lower() in SCRIPT_EXT:
        return "script"
    if is_binary(path):
        return "binary"
    try:
        if path.open("rb").read(2) == b"#!":
            return "script"
    except OSError:
        pass
    return "text"


def scan(root):
    root = Path(root).resolve()
    files, flags, licenses = [], [], set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            rel = str(p.relative_to(root))
            if p.is_symlink():
                files.append({"path": rel, "kind": "symlink", "target": os.readlink(p)})
                flags.append({"file": rel, "line": 0, "category": "symlink",
                              "why": f"points at {os.readlink(p)}; could reach outside the skill", "text": ""})
                continue
            k = kind(p)
            st = p.stat()
            files.append({"path": rel, "kind": k, "bytes": st.st_size, "executable": bool(st.st_mode & 0o111)})
            if k == "binary":
                flags.append({"file": rel, "line": 0, "category": "binary",
                              "why": "cannot be read; treat as unknown code if anything runs it", "text": ""})
                continue
            text = p.read_text(errors="replace")
            if re.match(r"(LICEN[CS]E|COPYING)", fn, re.I):
                licenses |= {name for name, rx in LICENSE_HINTS if re.search(rx, text)} or {"unrecognized"}
            is_prose = p.suffix.lower() in {".md", ".txt"}
            rules = RULES + (PROSE_RULES if is_prose else [])
            in_fence = False
            for n, line in enumerate(text.splitlines(), 1):
                if is_prose and line.lstrip().startswith(("```", "~~~")):
                    in_fence = not in_fence
                    continue
                for cat, rx, why in rules:
                    if is_prose and not in_fence and cat not in PROSE_CODE_CATEGORIES:
                        continue
                    if re.search(rx, line, re.I if cat == "prompt-injection" else 0):
                        flags.append({"file": rel, "line": n, "category": cat, "why": why, "text": line.strip()[:200]})
    skill_md = root / "SKILL.md"
    meta = {"has_skill_md": skill_md.exists()}
    if skill_md.exists():
        body = skill_md.read_text(errors="replace")
        fm = frontmatter(body)
        meta.update({"frontmatter_ok": fm is not None, "name": (fm or {}).get("name"),
                     "description": (fm or {}).get("description"), "license_field": (fm or {}).get("license"),
                     "skill_md_lines": body.count("\n") + 1})
        if fm:
            d = fm.get("description") or ""
            meta["description_chars"] = len(d)
            meta["description_says_when"] = bool(re.search(r"\b(use (when|for|this|if)|trigger|whenever)\b", d, re.I))
            meta["name_matches_folder"] = fm.get("name") == root.name
        meta["referenced_files_missing"] = sorted(
            {m for m in re.findall(r"(?:\$SKILL_DIR|\$\{CLAUDE_PLUGIN_ROOT\}|\{baseDir\})/([\w./-]+)", body)
             if not (root / m).exists()})
    hosts = sorted({h for f in files if f.get("kind") in ("script", "text")
                    for h in re.findall(r"https?://([A-Za-z0-9.-]+)", (root / f["path"]).read_text(errors="replace"))})
    return {"root": str(root), "meta": meta, "licenses_found": sorted(licenses), "hosts_mentioned": hosts,
            "files": files, "flags": flags}


def report(r):
    m = r["meta"]
    out = [f"skill: {r['root']}"]
    if not m["has_skill_md"]:
        out.append("  NO SKILL.md at the top level")
    else:
        out.append(f"  name: {m.get('name')!r}  matches folder: {m.get('name_matches_folder')}")
        out.append(f"  description: {m.get('description_chars', 0)} chars, says when to use: {m.get('description_says_when')}")
        out.append(f"  SKILL.md: {m.get('skill_md_lines')} lines")
        if m.get("referenced_files_missing"):
            out.append(f"  referenced but missing: {', '.join(m['referenced_files_missing'])}")
    out.append(f"  license: {', '.join(r['licenses_found']) or 'no LICENSE file'}"
               + (f"; frontmatter says {m['license_field']}" if m.get("license_field") else ""))
    out.append(f"  hosts mentioned: {', '.join(r['hosts_mentioned']) or 'none'}")
    out.append("\nfiles (read every script and binary entry yourself):")
    for f in r["files"]:
        extra = f" -> {f['target']}" if f["kind"] == "symlink" else f"  {f['bytes']}B{'  +x' if f.get('executable') else ''}"
        out.append(f"  {f['kind']:7} {f['path']}{extra}")
    by_cat = {}
    for fl in r["flags"]:
        by_cat.setdefault(fl["category"], []).append(fl)
    out.append(f"\nflags: {len(r['flags'])}" + ("" if r["flags"] else " (still read the scripts)"))
    for cat in sorted(by_cat):
        out.append(f"  [{cat}] {by_cat[cat][0]['why']}")
        for fl in by_cat[cat][:15]:
            out.append(f"    {fl['file']}:{fl['line']}  {fl['text']}")
        if len(by_cat[cat]) > 15:
            out.append(f"    ...and {len(by_cat[cat]) - 15} more")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("skill_dir")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if not Path(args.skill_dir).is_dir():
        sys.exit(f"not a directory: {args.skill_dir}")
    r = scan(args.skill_dir)
    print(json.dumps(r, indent=2) if args.json else report(r))


if __name__ == "__main__":
    main()
