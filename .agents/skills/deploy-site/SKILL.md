---
name: deploy-site
description: 'Put a static web page on the public internet for free and hand back its live URL — one .html file or a folder, including an HTML artifact saved in Mossbear. Use for /deploy-site, "deploy this page", "put this online", "give me a link I can share", "host this HTML", "publish this artifact as a website", or as the last step of a skill that builds a page to share. Do not use for anything with a server, a database or secrets, or to deploy the Mossbear product itself (that is the release workflows).'
argument-hint: 'Example: "Deploy this Mossbear artifact so I can send it to friends: <artifact URL>"'
user-invocable: true
metadata:
  mossbear-id: r6xBwgRslRICYeSElXOR1V
---

# Deploy Site

Publish a static page to [here.now](https://here.now) and return the URL. One command, no build step, no repo, nothing to install beyond `python3`.

**Self-contained.** This skill needs nothing else in the repo it sits in. The script lives next to this file; commands below write `$SKILL_DIR` for that directory.

```bash
SKILL_DIR=<the directory containing this SKILL.md>
```

## Why here.now

Chosen on 2026-10-25 for being the shortest path from a file to a shareable link, at no cost:

- **No account to get a URL.** An anonymous publish is live in about 25 seconds and lasts 24 hours.
- **Free account keeps sites for good.** Signing up is one emailed code, done from the terminal. The free plan has 500 permanent sites and 10 GB.
- **It is made for agents.** It's a plain HTTP API: create, upload, finalize. It is served from Cloudflare's edge, and it adds link-preview tags to each page it serves, so a link pasted into a chat app shows a card.

Runners-up, for when here.now stops fitting: **Cloudflare Pages** (free, unlimited bandwidth, but you need an account, an API token and `wrangler` before the first deploy), **Surge** (free, but signing up is interactive), **GitHub Pages** (free, but needs a public repo and a build that takes a minute or so).

## Do Not Use

- **For anything that is not meant to be public.** A here.now URL is open to anyone who has it. Publish only what the person asked to share.
- **For server code, databases, API keys or form handling.** It only hosts static files.
- **To ship an app that has its own release workflow.** Use that workflow.

## Procedure

### 1. Get the page onto disk

The script takes **one `.html` file** (it is served as `index.html`) or **a folder with an `index.html` at its top level** (served as-is, so relative links to images and CSS keep working). Files and folders whose names start with `.` are skipped.

Write working files to the session's scratchpad, not the repo.

- **A file or folder already on disk:** use it as-is.
- **An HTML artifact in Mossbear:** read it with the `read_artifact` MCP tool, then write its `content` to `<scratch>/<name>/index.html`. If the content is a fragment with no `<html>` element, wrap it in a minimal page: doctype, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">` and a `<title>`. A markdown artifact is not a page. Render it to HTML first, or tell the person it isn't one.
- **A photo with a caption to share:** use the `polaroid` skill instead. It builds the page and then hands it back here.
- **A photo from Mossbear:** pull it with `pull_artifacts` (`inbox: true`, or the `bundle` it is filed in) and `writeToDir` set to the site folder. Keep the default `display` copy, which is upright and has no location or camera metadata. **Never publish the `original` copy:** it can carry the GPS location where the photo was taken. Reference the written file from `index.html` by a relative path.

### 2. Publish

```bash
python3 "$SKILL_DIR/deploy.py" publish <file-or-folder> --title "<short name>"
```

It prints one JSON object:

```json
{
  "ok": true,
  "url": "https://keen-atlas-7g4f.here.now/",
  "slug": "keen-atlas-7g4f",
  "files": 2,
  "uploaded": 2,
  "persistence": "expiring",
  "expiresAt": "2026-10-26T22:40:15.741Z",
  "claimUrl": "https://here.now/c/<token>"
}
```

`"ok": false` comes with an `error` that names the failing request and the HTTP status. Most of the wait is the server finalizing: it takes about 20 seconds, and the script waits up to 120.

### 3. Report

Give the person the `url`. Report persistence from the output, never from whether a key was set:

- **`"persistence": "expiring"`** with a `claimUrl`: say the site disappears at `expiresAt` (about 24 hours), and pass on the `claimUrl` **exactly as printed**. Never shorten or truncate it. It is shown once, and opening it in a browser and signing in keeps the site. Offer step 4 so the next site is permanent from the start.
- **`"persistence": "permanent"`**: just the URL.

A skill that called this one reads `url` from the JSON and passes it back up.

### Update a site in place

To change a page and keep its URL, publish again with its slug:

```bash
python3 "$SKILL_DIR/deploy.py" publish <file-or-folder> --slug keen-atlas-7g4f
```

Only changed files are uploaded. An anonymous site can be updated only from the machine that created it: its claim token is kept in `~/.herenow/sites.json`. A site owned by an account can be updated from anywhere the key is set.

### 4. One-time setup for permanent sites (optional)

Ask the person which email to use. Then:

```bash
python3 "$SKILL_DIR/deploy.py" login <email>          # here.now emails a code
python3 "$SKILL_DIR/deploy.py" verify <email> <code>  # the person reads you the code
```

`verify` creates the account if it is new and saves an API key to `~/.herenow/credentials` with mode 0600. It **never prints the key**. Keep it that way: don't `cat` the file or echo the variable. From then on every publish is permanent. To keep an anonymous site published before logging in, run `python3 "$SKILL_DIR/deploy.py" claim <slug>` on the same machine.

**Cloud sessions** (claude.ai/code) start from a fresh container each time, so `~/.herenow/credentials` does not survive. The person can put the key in the environment's variables as `HERENOW_API_KEY`, which the script reads first. Getting it there is their step: they make a key in their here.now account and paste it into the environment settings themselves. Never write it into the repo, a commit, or the transcript. A lost key is not a problem: running `login` and `verify` again issues a fresh one.

## Network

The script talks to `here.now`, and uploads go directly to `*.r2.cloudflarestorage.com` (the exact host is in each upload URL). In an environment with an egress allowlist, both must be allowed. If finalize fails and lists every file as missing, the uploads never reached storage: check the second host.

## Decision Rules

- **The person asking to deploy something is the go-ahead to publish that thing.** It is not a go-ahead to publish other files you happen to have. Anything else gets a question first.
- **Prefer a folder over inlining.** Keep images as files next to `index.html` rather than base64 in the HTML: the page loads faster and the link-preview image works.
- **One site per thing shared.** A new page gets a new site. Use `--slug` only when the person wants the same link to show new content.
