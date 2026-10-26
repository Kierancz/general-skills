---
name: address-review
description: 'Read pull request review comments, triage valid vs stale feedback, implement narrow fixes, validate them, and push the PR branch. Use for /address-review, PR review follow-up, inline comment triage, GitHub review threads, gh api graphql reviewThreads, reviewer feedback fixes, and Claude Code or Copilot review cleanup. Do not use for opening new PRs or broad unsolicited refactors. Do not mark review threads as resolved — leave that decision to the human reviewer.'
argument-hint: 'Describe the PR number or branch, the review comments to address, and any validation or push constraints.'
user-invocable: true
---

# Address Review

Use this skill when the task is to read PR review feedback, judge which comments are correct, implement the valid fixes, validate them, and push the result.

Do **not** resolve review threads. Leave that to the human reviewer — they decide when feedback is addressed to their satisfaction. Marking threads resolved on their behalf hides context they may still want to act on.

## GitHub Tooling (cloud vs local)

This skill runs in two kinds of environment. Detect which environment once, at the start, and use the matching interface for every GitHub operation below:

- **Cloud agents** (Claude Code on the web, GitHub Actions): the `mcp__github__*` MCP tools are available and the `gh` CLI usually is not. Prefer the MCP tools.
- **Local agents**: the MCP tools are usually absent and `gh` is installed. Fall back to `gh` (with `GH_PAGER=cat PAGER=cat`) and the GraphQL queries in [GitHub review queries](references/github-review-queries.md).

Rule: if `mcp__github__*` tools are present, use them; otherwise use `gh`. Fetching, switching branches, and pushing always go through plain `git` in both environments.

| Operation | Cloud (MCP) | Local (`gh`) |
|---|---|---|
| PR metadata (head ref/OID, base, url) | `mcp__github__pull_request_read` (`get`) | `gh pr view --json ...` |
| Read review threads/comments | `mcp__github__pull_request_read` (`get_review_comments`) | `gh api graphql` reviewThreads |
| Reply on a review comment | `mcp__github__add_reply_to_pull_request_comment` | `gh api .../replies` |

`mcp__github__pull_request_read` with `get_review_comments` returns each thread's `isResolved` / `isOutdated` for triage — the same fields the GraphQL query surfaces. Do **not** resolve threads in either environment: never call `mcp__github__resolve_review_thread` and never call the GraphQL `resolveReviewThread` mutation. The `owner`/`repo`/`pullNumber` come from the `origin` remote and the PR. The `gh` commands in the Procedure below are the local form; use the MCP equivalent when the MCP tools are available.

## When To Use

- Review inline PR comments on the current branch.
- Triage which comments are valid versus optional or incorrect.
- Make narrow follow-up fixes and push them to the PR branch.
- Re-check whether previously raised review comments still apply.

## Never Do

- Do not call `resolveReviewThread` (GraphQL), `mcp__github__resolve_review_thread`, or any equivalent UI/REST action to mark threads resolved.
- Do not mass-collapse or hide threads, even ones GitHub already marks `isOutdated`.
- Reviewers own thread state. Reply with the fix commit hash if you want the trail to be visible.

## Do Not Use

- Creating a new PR from scratch.
- Doing a general code review without specific review feedback.
- Bundling unrelated cleanups into the review follow-up.

## Inputs To Gather

- PR number or current branch.
- Repo owner/name if it is not obvious from `origin`.
- PR head ref, head OID, base ref, and PR URL.
- Review comment URLs and outdated state (for triage only — do not change thread resolved state).
- Current working tree state.
- Relevant file contents before editing, especially if the user or formatter may have changed them.
- Validation hooks or required commands if the repo defines them.

## Procedure

1. Sync to the PR head first.
   - Fetch `headRefName`, `headRefOid`, `baseRefName`, and `url` — `gh pr view` locally, or `mcp__github__pull_request_read` (`get`) in the cloud.
   - Compare the PR head with the local branch and `git rev-parse HEAD`.
   - If the local checkout is not on the PR head, fetch and switch to it before reading reviewed files.
   - If switching would overwrite unrelated local changes, stop and clarify instead of guessing.
2. Capture the repo state.
   - Run `git status --short --branch`.
   - If `.husky/pre-commit` exists, read it early so commit-time validation is not a surprise.
3. Fetch review data non-interactively.
   - Cloud: `mcp__github__pull_request_read` with `get_review_comments` (threads + `isResolved`/`isOutdated`) and `get_reviews` for review summaries.
   - Local: always set `GH_PAGER=cat PAGER=cat`; prefer the GraphQL review thread queries in [GitHub review queries](references/github-review-queries.md); quote `gh api` REST paths if they contain `?` or other shell-sensitive characters.
4. Separate comments into:
   - valid and actionable
   - stale or already fixed
   - non-blocking preference
   - incorrect
5. Read the current file contents before changing anything.
6. Fix only the valid comments with minimal edits.
7. Run the smallest useful validation for the touched area.
   - Docs or text-only changes: verify routes, APIs, or source references directly and run `git diff --check`.
   - Code changes: formatter, lint, and typecheck first for the touched scope.
   - Behavior changes: run targeted tests when behavior changed.
   - If the repo hook defines required checks, run them before commit when practical.
8. Commit only if the user’s workflow implies finalizing the follow-up.
   - Stage only the intended files.
   - Do not bypass hooks unless the user explicitly asks.
9. Push the branch and confirm the PR head was updated.
10. Optionally reply on the original comment with the fix commit hash so the trail is visible (`mcp__github__add_reply_to_pull_request_comment` in the cloud, `gh api .../replies` locally). Do **not** mark the thread resolved — that is the reviewer's call.

## Decision Rules

- Treat factual mismatches, stale examples, wrong routes, incorrect auth contracts, unsafe logging, and real test gaps as valid.
- Treat comments as stale when the current file no longer matches the diff hunk or the requested fix is already present.
- Push back on comments that require speculative refactors or change behavior without evidence.
- If a comment is valid but risky, prefer the narrowest safe fix and mention remaining tradeoffs.
- Do not silently overwrite unrelated local edits.

## Good Defaults

- Use the environment's GitHub interface (MCP tools in the cloud, `gh` locally) instead of asking the user to open GitHub manually.
- Cloud: prefer `mcp__github__pull_request_read` (`get_review_comments`) — it returns threads, states, and comment bodies in one call.
- Local: prefer GraphQL `reviewThreads` over mixed REST calls for inline feedback because it returns thread IDs, states, and comment bodies in one request; use `GH_PAGER=cat PAGER=cat` for any `gh` call that may page; quote `gh api` paths that contain query parameters.

## Output Standard

- Tell the user which comments were addressed and why.
- Call out any comments you chose not to implement, with a short reason.
- Report exactly what validation ran.
- Give the updated PR URL and pushed commit hash.
- Note that thread resolution was left to the reviewer (do not resolve threads).

## References

- Use [GitHub review queries](references/github-review-queries.md) for reusable `gh api graphql` commands.