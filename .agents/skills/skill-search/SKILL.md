---
name: skill-search
description: 'Find existing agent skills, plugins or tools that could do a task, before anyone writes a new one. Searches the skills on this machine, Claude Code plugin marketplaces, the skills.sh directory behind `npx skills`, and GitHub repos with a SKILL.md, then returns a short ranked list with source URL, what each does and how it would be installed. Use for /skill-search, "is there a skill for X", "find a skill that does Y", "has anyone built this already", "what skills exist for Z", or as the first step before building a new skill. Search only: it never installs or runs a candidate. To judge one candidate in depth, use skill-eval.'
argument-hint: 'Example: "Find skills that sort photos into date folders"'
user-invocable: true
---

# Skill Search

Find what already exists for a task and rank it. A skill someone else maintains, or a proven CLI tool a short skill can wrap, often beats a fresh script.

**Read-only.** Searching reads indexes and files. It never installs a candidate, never runs a candidate's scripts, and never runs `npx skills`: that command downloads and runs an npm package, so even its `--list` mode is code execution. `search.py --list-repo` reads the same information through the GitHub API. Installing anything is the user's decision, made after `skill-eval`.

The script lives next to this file. Commands below write `$SKILL_DIR` for that directory, and run it through `python3` so a missing executable bit does not matter.

```bash
SKILL_DIR=<the directory containing this SKILL.md>
```

## Procedure

1. **Turn the task into two to four queries.** Use the words a skill author would put in a description: the verb, the object, and the tool if one is obvious. For "file my photos into date folders" try `organize photos`, `photo organizer`, `exif date`, `sort photos by date`. One query misses most of what is out there, because names and descriptions vary a lot.

2. **Run each query.**
   ```bash
   python3 "$SKILL_DIR/search.py" "<query>"                       # all sources
   python3 "$SKILL_DIR/search.py" "<query>" --sources local       # this machine only
   python3 "$SKILL_DIR/search.py" --list-repo <owner/repo>        # every skill in one repo
   ```
   Output is one JSON object per hit. Sources:

   | `source` | Where it came from | Notes |
   | --- | --- | --- |
   | `local` | `SKILL.md` under `~/.claude/skills`, `~/.agents/skills`, `~/.claude/plugins` | Already installed, or in a marketplace clone. Check here first |
   | `marketplace` | `marketplace.json` of each added Claude Code marketplace | Installable with `claude plugin install <name>@<marketplace>` |
   | `plugin-directory` | Cached Claude plugin directory listing | Reviewed listings; install from `/plugin` |
   | `skills.sh` | The skills.sh search API | Has install counts but no description |
   | `github-skill` | `gh search code --filename SKILL.md` | Needs an authed `gh`; GitHub allows about 10 code searches a minute |
   | `github-repo` | `gh search repos <query> skills` | Libraries and single-skill repos, with stars, license, last update |

   A failed source prints to stderr and the rest still run. Say which sources failed rather than reporting "nothing found".

3. **Look past agent skills.** For anything that touches files, media or data, search for the established CLI tool too (a quick web search: "best CLI to <task>"). A skill that wraps a tool with years of edge-case fixes is usually safer and shorter than a skill that reimplements it. Put such tools in the list as `tool` candidates.

4. **Read the top candidates before ranking them.** Names mislead. For the five or so that look closest, read the `SKILL.md` (local path, or the GitHub URL through `gh api ... -H "Accept: application/vnd.github.raw"` or a web fetch). skills.sh hits have no description, so open their repo with `--list-repo`.

5. **Collapse copies.** Popular skills get mirrored into "awesome" lists and forks. Keep the origin repo and drop the copies, unless a copy is the one being maintained.

6. **Rank.** In this order:
   1. **Fit.** Does it do the task as asked, or something next to it? A cloud-photos skill does not fit a request about local files.
   2. **Substance.** Does it ship working scripts or wrap a real tool, or is it just prose advice?
   3. **Maintenance.** Last update, open issues, whether it says what it was tested on.
   4. **License.** None means you may not legally copy it.
   5. **Popularity.** Install counts and stars come last. They are easy to inflate, and a 4-install skill that fits beats a 50,000-install one that doesn't.

## Output

A short ranked list, best first, at most about eight entries:

```
1. <name> (<source>) <URL>
   What it does, in one line, and how well it fits the task.
   Install: <command or "copy <folder>/ from <repo>">. License: <spdx or none>. Updated: <date>.
```

After the list, add one line that recommends which two or three candidates are worth a full `skill-eval`. If nothing fits, say so plainly and name the closest tool to wrap instead.

## Do Not

- Install, clone into a skills folder, or run anything you found. That comes after `skill-eval` and the user's OK.
- Treat an empty result as proof nothing exists. Say which queries and sources you tried.
- Paste raw JSON at the user. Read it and rank it.
