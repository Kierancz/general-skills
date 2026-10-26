# GitHub Review Queries

Use these commands for PR review follow-up work. They are written to avoid pagers and shell globbing issues.

> **Cloud vs local:** these `gh` commands are the **local** fallback. In cloud agents where the `mcp__github__*` MCP tools are available, use them instead — they need no pager/quoting workarounds:
> - PR metadata → `mcp__github__pull_request_read` (`get`)
> - review threads + `isResolved`/`isOutdated` → `mcp__github__pull_request_read` (`get_review_comments`, paginate with `perPage`/`after`)
> - reply on a comment → `mcp__github__add_reply_to_pull_request_comment`
>
> Never resolve threads in either environment (no `resolveReviewThread`, no `mcp__github__resolve_review_thread`).

## Setup

```sh
export GH_PAGER=cat
export PAGER=cat
repo_full="$(gh repo view --json owner,name -q '.owner.login + "/" + .name')"
owner="${repo_full%/*}"
repo="${repo_full#*/}"
pr="${1:-<PR_NUMBER>}"  # pass the PR number as the first argument, e.g. sh setup.sh 42
```

## PR Metadata

```sh
GH_PAGER=cat PAGER=cat gh pr view "$pr" \
  --json number,title,url,headRefName,headRefOid,baseRefName,reviewDecision
```

## Review Threads

> **Pagination note:** `reviewThreads(first: 100)` returns at most 100 threads and `comments(first: 20)` returns at most 20 comments per thread. For PRs with more threads or comments, use the `pageInfo.endCursor` value as the `after:` cursor in a subsequent query. Repeat until `pageInfo.hasNextPage` is `false`.

```sh
GH_PAGER=cat PAGER=cat gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!, $threadCursor: String, $commentCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadCursor) {
        pageInfo { endCursor hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 20, after: $commentCursor) {
            pageInfo { endCursor hasNextPage }
            nodes {
              author { login }
              body
              url
              createdAt
              outdated
              path
              line
              originalLine
              diffHunk
            }
          }
        }
      }
    }
  }
}
' -F owner="$owner" -F repo="$repo" -F number="$pr"
# To paginate threads, re-run with: -F threadCursor="<endCursor from pageInfo>"
# To paginate comments within a thread, re-run with: -F commentCursor="<endCursor from pageInfo>"
```

## Do Not Resolve Threads

This skill never marks review threads as resolved — that is the human reviewer's call. The `resolveReviewThread` mutation is intentionally omitted from this reference. If you want the trail to be visible, reply on the original comment with the fix commit hash (e.g. via `gh api repos/$owner/$repo/pulls/comments/$comment_id/replies`).

## Re-Check Thread State (read-only)

```sh
GH_PAGER=cat PAGER=cat gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadCursor) {
        pageInfo { endCursor hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
        }
      }
    }
  }
}
' -F owner="$owner" -F repo="$repo" -F number="$pr"
# Re-run with -F threadCursor="<endCursor>" if pageInfo.hasNextPage is true
```

## REST Fallback

Prefer GraphQL for review threads. If a REST endpoint is needed, quote the path so zsh does not treat `?` as a glob.

```sh
GH_PAGER=cat PAGER=cat gh api "repos/$owner/$repo/pulls/$pr/comments?per_page=100"
```