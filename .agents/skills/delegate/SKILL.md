---
name: delegate
description: Hand a bounded task to a cheap open-weights model on OpenRouter (GLM flash by default) running headless under OpenCode on this machine, and read back a compact result whose facts the launcher checked — so Claude usage goes to deciding, not reading or typing. Two modes, scout (read-only questions) and worker (edits inside a declared scope, graded by checks the launcher runs itself). Use for fan-out search ("find every caller of X", "map this subsystem"), CI-log or long-file digestion, web or GitHub research, and mechanical edits with a check (a rename across files, fixing type errors, tests against an existing spec); "delegate this", "scout this", "have a flash model do it", "save usage". Do not use for anything that decides (specs, security/design review, access-control or data-scoping logic, migration design, user-facing copy), for an edit with no mechanical check, or for work a deterministic script already does.
---

# Delegate

Reading is the expensive part of most agent work, and most reading does not need a frontier model. This skill hands a bounded read or a mechanically checkable edit to a flash-tier model on OpenRouter, running headless under OpenCode, and gives back a short result in which everything except the model's own answer is a fact the launcher observed. The launcher cannot enforce the routing rules below, so follow them as written.

**Self-contained.** The launcher lives next to this file and needs nothing from the repo it runs in — no `package.json` script, no `node_modules`, no `opencode.json`. Commands below write `$SKILL_DIR` for this directory.

```bash
SKILL_DIR=<the directory containing this SKILL.md>
```

**Two modes.** A **scout** reads, searches and reports; it never edits. A **worker** edits the paths its brief scopes, leaves the change uncommitted, and the launcher then runs the brief's checks itself — their exit codes, not the worker's summary, decide the status. Review mode, and a worker's `ladder` and `git` keys, are not built yet and are refused.

## Prerequisites

- **Bun**, to run the launcher.
- **OpenCode 2.x.** On linux-x64 the launcher downloads its pinned, digest-checked release to `~/.opencode/v2/bin/` on first use. Elsewhere it uses an `opencode` on PATH that reports a 2.x version, or the binary `DELEGATE_OPENCODE_BIN` names.
- **`OR_DELEGATE_API_KEY`** in the environment: an OpenRouter key with a spend cap, kept apart from any other OpenRouter key on the machine.
- **git**: the run must start inside a git checkout, because the launcher diffs the tree and refs around it.

Without any of these the run reports `skipped` with the reason and spends nothing. That is not a failure: do the task yourself and say delegation skipped and why.

**Mossbear tracking follows the project.** A project with Mossbear's OpenCode plugin (`.opencode/plugins/mossbear.ts`, written by `mossbear init`) has every run recorded, or the run is skipped: it also needs `mossbear-hook` on PATH and a `MOSSBEAR_TOKEN` the dashboard accepts, because a hook that cannot upload spends credits and records nothing. A project without the plugin runs untracked, and the result says so.

## Route first

- A read-only question that means reading many files, a long log, or the web → scout it, `tier: flash`.
- An edit with a mechanical check (typecheck, a test file, lint) → worker it, `tier: flash`, or `pro` for multi-file work from an approved spec.
- An edit with no check → do it yourself. No oracle, no delegated write.
- Anything that **decides** → do it yourself. A flash model deciding is the failure the routing exists to prevent.
- Deterministic work (format, i18n extraction, snapshots, migration generation) → run the script.
- Small enough to answer with two greps → just grep. A delegation costs about 1.5K of your tokens round trip.

## Brief

Write `.delegate/<short-id>/brief.md` at the repo root, and keep `.delegate/` out of git (add it to `.gitignore` if the project has not). Frontmatter is config, the body is the prompt:

```markdown
---
mode: scout
tier: flash          # optional: flash (default) | flash-alt | pro
budget_usd: 0.25     # optional: defaults from the tier file
timeout_min: 10      # optional: default 20
---
## Question
Which call sites pass `chunkPayloads` a payload over 1 MB?

## Read first
- src/upload/client.ts

## Answer as
One line, then `path:line` per call site.
```

- **Paths, never pasted contents.** A path costs you a few tokens; the scout reads the file on its own meter.
- Under 40 lines. Ask one question; the answer comes back capped at 1,500 characters.
- An unknown key is refused, not ignored — `budget_usd`, not `budget`.

A worker brief adds two required keys:

```markdown
---
mode: worker
tier: flash
scope: ["src/upload/**", "tests/upload-client.test.ts"]
checks:
  - npx tsc --noEmit
  - npx vitest run tests/upload-client.test.ts
---
## Goal
Make `chunkPayloads` split on byte size, not item count.

## Done when
Both checks pass and a new test covers a 3 MB payload.

## Read first
- src/upload/client.ts

## Don't
Change the request shape or the public function signature.
```

- `scope`: globs from the repo root. A changed path outside all of them makes the run `out_of_scope`. Tight is better — it is the part of the diff you get to accept without reading.
- `checks`: shell commands run from the repo root after the worker stops, each with a 10-minute cap. Pick checks that grade the change and do not write to the tree (no formatter, no code generator); run those yourself when accepting.
- Commit or stash anything already dirty inside `scope` first: the launcher refuses to start a worker on it, because it could not tell your edit from the worker's.

### Tiers

A tier is a name for an OpenRouter model slug plus the reasoning effort and provider routing it runs with. The defaults are in `$SKILL_DIR/tiers.json`: `flash` (GLM flash, the default), `flash-alt`, `pro`, and `max`, which has no model yet and is refused. A project can replace the whole file with its own `.delegate/tiers.json` in the same shape; to commit it while keeping run output ignored, ignore `.delegate/*` and add `!.delegate/tiers.json`. A tier whose options do not state a reasoning object and routing (`provider.sort`, or a `provider.order` list) is refused rather than run unrouted, because an unrouted model's worse output reads exactly like good output.

## Run

One Bash call with `run_in_background: true`, from inside the repo:

```bash
bun "$SKILL_DIR/scripts/index.ts" .delegate/<id>/brief.md
```

Do not poll, `sleep`, or open the transcript while it runs. You are re-invoked when it exits. It always exits 0 once it has written a result; the status is inside.

Do not edit the working tree while a scout or worker runs. The launcher diffs the tree around the run, and it cannot tell your edits from the run's — an edit of yours reads as `out_of_scope`. Everything under `.delegate/` is left out of that diff, so briefs you write and scouts you start meanwhile are not counted against a running one.

## Read

Read `.delegate/<id>/result.md` only — it is at most 60 lines, status first. `Worker claims (unverified)` is the model's answer and is a claim; the status, exit, tree changes and cost are facts the launcher observed.

- **`done`** → a scout: use the answer. Spot-check one cited `path:line` before you build on it, when a wrong answer would cost more than the check. A worker: every check passed and every changed path is in scope. `git diff` is yours to skim, then commit it; if `Sensitive` lists paths (auth, API routes, server code, database, CI workflows), read those hunks, or have them security-reviewed, before accepting — passing checks do not vouch for them.
- **`checks_failed`** → the worker's edit is in the tree and a check failed; each check's log is named in `result.md`. Fix it yourself if the gap is small, or `git checkout -- <scope>` and re-brief narrower. Never loosen the check.
- **`no_change`** → the worker stopped without editing anything. Its claims usually say why; re-brief or do it yourself.
- **`out_of_scope`** → paths changed (for a worker: outside its `scope`), or git refs moved (a commit, a branch switch, a stash, a push), while the run went on. It outranks every other status, and the reason says how the run itself ended. Everything is listed and left in place. If you made those changes yourself meanwhile, the answer still stands; otherwise look at them (`git status`, `git log`), then revert or keep deliberately.
- **`timeout` / `budget_exceeded`** → the question was too wide. Narrow it and re-brief, or do it yourself. Never re-run the same brief unchanged.
- **`harness_error`** → read the last lines of `stderr.log` next to the result; then re-brief or do it yourself. A harness that lost the startup race for OpenCode's database (`database is locked`) has already been retried once — the first attempt in `result.md` says so — so a second lock is not worth a third try.
- **A worker that ended `timeout`, `budget_exceeded` or `harness_error`** usually left a half-made edit in the tree, and no check graded it. Treat it as unreviewed: finish it yourself and run the checks, or revert the files `Tree changed` lists (`git checkout -- <paths>`, and delete the new ones). A re-brief refuses to start until the scope is clean again.
- **`skipped`** → nothing ran (a missing prerequisite, a key OpenRouter rejected, a tier with no model or no routing, a half-wired Mossbear; for a worker also a dirty `scope`, or another worker holding `.delegate/worker.lock`). Do the task yourself and say that delegation skipped and why.

Open `result.json` or the transcript only when the status and the facts disagree.

## What a run can reach

The repo, the shell (a scout's is read-only by instruction and its `edit` is denied; a worker can edit, but `git commit`, `push`, `checkout`, `switch`, `reset`, `stash`, `rebase` and `merge` are denied — you commit what you accept), files under `/tmp`, web search and fetch, GitHub's REST API wherever the environment supplies a credential for it, public files of any GitHub repo through `raw.githubusercontent.com`, and the read-only tools of the `mossbear` MCP server when `mossbear` is on PATH. Subagents and browser tools are denied for both, and so is every tool of an MCP server the project's own `opencode.json` declares. The launcher generates the agents, permissions and model settings for each run and hands them to OpenCode for that run only; the project's `opencode.json` is never read for them or written.

**Parent-only:** connectors (mail, drives, docs), artifacts, scheduling and session tools, PR-activity subscriptions, and GitHub MCP tools. A brief never depends on them.

## Never

Paste file contents into a brief. Delegate a decision. Delegate an edit with no check. Run a second worker in the same checkout. Re-run a failed brief unchanged. Name `max` (it has no model and is refused).
