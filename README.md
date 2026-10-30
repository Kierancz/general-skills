# general-skills

Agent skills that are not tied to any one codebase. Each lives in `.agents/skills/<name>/` as a `SKILL.md` plus any scripts it runs.

| Skill | What it does |
| --- | --- |
| `address-review` | Triage pull request review comments, fix the valid ones, push |
| `bill-split` | Itemize the newest receipt in the Mossbear inbox and publish a 24-hour calculator: drag items onto people, add tip and fees, send Venmo requests by link or QR code |
| `deploy-site` | Put a static page on the public internet with here.now and return its URL |
| `orchestration` | Split work across subagents and sessions, with a model per subtask |
| `photo-filer` | File photos and videos into `YEAR/YEAR-MM-DD/` folders with exiftool: plan first, log and undo, duplicates set aside |
| `reddit-rss` | Pull public Reddit posts and comments to JSONL through RSS, no API key |
| `skill-creator` | Create, test and tune skills |
| `skill-eval` | Judge whether someone else's skill is worth adopting, adapting or ignoring, including a read of every script it ships |
| `skill-search` | Find existing skills, plugins and tools for a task across this machine, plugin marketplaces, skills.sh and GitHub |
| `transcribe-audio` | Transcribe audio with mlx-whisper on Apple Silicon |
| `unslop` | Cut AI tells from prose |
| `youtube-transcript` | Pull a YouTube video's captions to readable prose with yt-dlp |

## Getting them

This repo is the home of the `general-skills` bundle in [Mossbear](https://mossbear.io). Subscribe to it with global delivery and the skills land in `~/.claude/skills/` and `~/.agents/skills/` on every machine you use:

```bash
mossbear pull general-skills --account --deliver=global
```

Or copy a folder from `.agents/skills/` into your own skills directory.

## Publishing

`.mossbear/config.json` declares `.agents/skills/**` as published. After a change lands on `main`, run `mossbear publish` from a clone to update the bundle. Only this repo can write to it.

## Licenses

`skill-creator` comes from [anthropics/skills](https://github.com/anthropics/skills) under the Apache License 2.0 (`.agents/skills/skill-creator/LICENSE.txt`); this copy adds a section on reading Mossbear feedback for a skill. `unslop` is adapted from [cursor/plugins](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md).
