---
name: reddit-rss
description: 'Pull public Reddit posts and comments to JSONL through the RSS feeds, without an API key or an account. Use for /reddit-rss, "scrape reddit for X", "what are people saying on r/Y", "pull posts from that subreddit", "get that thread", or mining a community for the words people actually use.'
argument-hint: 'Example: "Pull the last week of r/ClaudeAI about rules files"'
user-invocable: true
---

# Reddit RSS

Fetch public Reddit listings as Atom feeds and flatten them to JSONL. No API key, no account, no dependencies beyond `curl` and `python3`.

This is desk research against a hostile, rate-limited upstream. The two things that make it work are **pacing** (about one request per minute) and **never mistaking a block for an empty subreddit**. Both are covered below, and both are easy to get wrong.

**Self-contained.** This skill needs nothing else in the repo it sits in. The two scripts live next to this file; commands below write `$SKILL_DIR` for that directory.

```bash
SKILL_DIR=<the directory containing this SKILL.md>
WORK=$(mktemp -d)   # feeds and JSONL are scratch; never write them into a checkout
```

## When To Use

- Reading what a community says about a topic, in their words rather than yours.
- Finding the recurring complaint, question or workaround behind a hunch.
- Pulling a specific thread, or a named user's submissions, that someone pointed you at.

## Do Not Use

- **To build a corpus.** RSS returns one page per feed with no pagination — roughly 25–100 posts, with no way to walk backwards. "Every post in r/X since January" is not reachable this way. See Decision Rules before improvising.
- **To reach comments at scale.** A post's comment feed is one request per post, and the sustained rate is about one request per minute — so a hundred posts is roughly **a hundred minutes**. Budget it before you start, or pick fewer threads.
- **When the ask needs scores or comment counts.** RSS does not carry them. See What RSS Does Not Give You — do not infer popularity from feed order, and do not fill the gap with `old.reddit`.
- **As a stand-in for talking to the people you actually need to hear from.** See Reading The Data Honestly.
- To fetch anything behind a login, a quarantine, or a private subreddit. If a feed needs an account, stop.

## The Endpoints

All are `https://www.reddit.com/…`, all serve **Atom** (despite the `.rss` suffix), all are public and need no auth.

| What | Path | Status |
|---|---|---|
| Subreddit listing | `/r/<sub>/<sort>.rss?limit=100` | **Verified 2026-09-19.** `sort` ∈ `new` `hot` `top` `rising` |
| Top over a window | `/r/<sub>/top.rss?t=week&limit=100` | **Verified** (63 entries). `t` ∈ `hour` `day` `week` `month` `year` `all` |
| Search within a subreddit | `/r/<sub>/search.rss?q=<q>&restrict_sr=1&sort=new` | **Verified** (25 entries). `sort` ∈ `relevance` `new` `top`; `t` as above |
| A user's submissions | `/user/<name>/submitted.rss` | **Verified** (23 entries, each tagged with its subreddit) |
| One post's comments | `/r/<sub>/comments/<id>.rss` | **Verified.** `<id>` is base36, no `t3_` prefix. See below |
| Several subreddits at once | `/r/<a>+<b>+<c>/new.rss` | **Verified** (10 entries, each tagged with the subreddit it came from) |

A **comment feed is shaped differently** and the parser does not hide it. The first entry is the post itself (`id` `t3_…`); every later entry is a comment (`id` `t1_…`) whose body lands in `selftext` and whose `url` is `null` — a link inside a comment's text stays in `selftext` and is never promoted to `url`. A comment's `title` is synthesised by Reddit as `/u/<name> on <post title>` — nobody typed that, so never quote it as a comment's own words.

`limit` is best-effort, not a promise: `top.rss?t=week&limit=100` returned 63 entries, while `search.rss?…&limit=25` returned all 25. There is no pagination — no `after`, no second page. **One feed is one page, and that is the ceiling.**

Every row above was run on 2026-09-19 and returned the entry count shown. **Check the entry count anyway** — a rate-limited fetch and a quiet subreddit look alike downstream.

## Procedure

1. **Preflight — one command, before anything else.**
   ```bash
   bash "$SKILL_DIR/fetch-feed.sh" --preflight
   ```
   It reports whether an egress proxy is in front of you, probes a control host, then probes Reddit, and exits non-zero if this machine cannot do the job. Run it first in any environment you have not already fetched from — see Sandboxed And Cloud Environments.

2. **Decide whether RSS can answer the question at all.** If the ask needs scores, comment counts, or more than ~100 posts per feed, stop here and go to Decision Rules. Do not start fetching and discover this halfway.

3. **Fetch with backoff.** This is the step that actually matters — see Rate Limiting.
   ```bash
   bash "$SKILL_DIR/fetch-feed.sh" "https://www.reddit.com/r/<sub>/new.rss?limit=100" "$WORK/out.xml"
   ```
   Pass several URLs to fetch them in sequence, paced:
   ```bash
   bash "$SKILL_DIR/fetch-feed.sh" --out-dir "$WORK/feeds" "<url1>" "<url2>" "<url3>"
   ```

4. **Flatten to JSONL.**
   ```bash
   python3 "$SKILL_DIR/rss-to-jsonl.py" "$WORK"/feeds/*.xml > "$WORK/posts.jsonl"
   ```
   The parser de-duplicates by id across feeds, so overlapping windows and multi-subreddit feeds are safe to combine.

5. **Interpret the result before going further.**

   | What you see | What it means | What to do |
   |---|---|---|
   | Atom with entries | Success | Continue |
   | `HTTP 429` | **Rate limited** — transient | Back off and retry; the script does |
   | `blocked: HTTP 200 with a block page` | **Blocked**, hard | Not retried — waiting will not turn HTML into Atom. Report as blocked |
   | `blocked: HTTP 200 with an empty body` | **Blocked**, possibly transient | Retried, because a truncated response looks identical. If every attempt is empty the verdict says blocked, not rate-limited |
   | `warn: … not an Atom feed (root <html>)` | **Blocked** — a block page is well-formed HTML | Same, from the parser rather than the fetcher |
   | `warn: … no entries` | Ambiguous | An empty listing *or* a block. Say it is ambiguous |
   | `HTTP 404`, "no such feed" | A wrong name, not a block | Check the subreddit/user/post id. Not retried |
   | `HTTP 403`, "refused" | Either a `.json` URL, or Reddit refusing this client | Use `.rss`; if it already is, run `--preflight`. Not retried |
   | `HTTP 000`, curl exit 56 or 7 | No HTTP response at all — usually an egress proxy | Run `--preflight`. Not retried |

   **An empty result is never evidence that a subreddit is quiet.** Reddit's limiter returns a zero-byte body on some paths and a well-formed HTML block page on others. A parser that only checks "did it parse" reports a block as an empty subreddit. Report what actually happened, and if the cause is genuinely ambiguous, say it is ambiguous.

6. **Read it and answer the question that was asked.** If someone wanted the recurring complaint, find it and quote it with its permalink. Do not paste 100 JSONL rows to answer "what are people saying about X."

## Rate Limiting

**The limiter is the whole engineering problem here.** Measured 2026-09-19 from one laptop IP, single-threaded, with a fresh 3–4 minute cooldown before each trial:

| Interval | Result |
|---|---|
| 5s | 2/8 — both at the very start, then `429` for the rest |
| 20s | 3/8 |
| 30s | 3/6, alternating exactly `200 429 200 429 200 429` |
| 60s | **5/5** |

**The sustained rate is about one request per minute.** The clean alternation at 30s is the tell: the bucket refills roughly once a minute, so at half that interval you win every other try. There is also a small burst allowance — about two requests — after a long idle, which is why a first fetch so often succeeds and tempts you into going faster.

Two consequences:

- **Pace at 60s between feeds.** `fetch-feed.sh` does (`PACE=60`). Going faster does not get the data sooner; it converts requests into `429`s and depletes the same bucket you are about to need.
- **Retry no sooner than the refill.** Backoff runs 30s, 60s, 120s, 240s. A retry 3 seconds after a `429` is free failure.

**`429` is transient, not a ban.** One feed returned `200` on the fourth attempt after three consecutive `429`s; another failed five attempts twice, then succeeded on the first attempt of a later run with nothing about the request changed. Never conclude you are blocked from a `429`, or even from a run of them — treat a sustained failure across *several different* feeds as the signal, never a single one.

**Do not run two fetchers at once.** Concurrency is what pushes this from occasional to constant, and it buys nothing: the bottleneck is Reddit, not you. Sequential at 60s finishes sooner and with less noise.

**Identify yourself.** Set `REDDIT_RSS_UA` to something that says who you are. Do not impersonate a browser to get around a block, do not rotate user agents, and do not add proxies on your own initiative — that is escalation against a host that has asked you to slow down, and it is the operator's call, not yours.

## Sandboxed And Cloud Environments

**Run `--preflight` and believe it.** Everything measured above was a laptop on a direct connection. A sandboxed agent environment — a cloud coding session, a CI runner, a container with a network policy — can differ in two ways that each stop this skill dead, and they need different answers:

- **An egress proxy with an allowlist.** Many such environments route outbound HTTPS through a policy proxy (`HTTPS_PROXY` / `https_proxy` set) that permits only listed hosts. A denial arrives as **`HTTP 000` with curl exit 56**, not as a `403`, because the refusal lands on the CONNECT tunnel rather than on an HTTP response. If Reddit is blocked this way, **report the blocked host and stop.** Routing around a network policy is not a technical problem to solve; it is a decision for whoever set the policy.
- **A datacenter IP.** Even with egress allowed, Reddit is hostile to datacenter ranges. That shows as `403`, or as `429` that never clears no matter how long you wait. No flag fixes it. The answer is to run from a residential connection, or an explicit decision by the operator about paying for a proxy — not something to arrange quietly.

`--preflight` tells these apart by probing a **control host first**. Without that control, "Reddit is blocked here" and "this sandbox has no egress at all" look identical, and only one of them is about Reddit.

**What is verified:** the four code paths — reachable, total egress failure, host-specific allowlist denial, and a proxy-refused fetch — were exercised on 2026-09-19 against local proxies built to imitate each case. Each produced the right diagnosis and exited without retrying. **What is not verified:** whether any particular cloud environment can reach Reddit. Run `--preflight` there and record what you find.

## What RSS Does Not Give You

The feed carries: id, title, author, published/updated timestamps, permalink, the outbound URL where the entry has one, and **the full body text where the entry has one**. That last one is why this is worth doing — the thing you actually want to read arrives complete.

`url` and `selftext` are **independent, not alternatives.** A link post whose submitter added a summary carries both — 24 of 118 captured records did. Do not infer "this was a link post" from an absent `selftext`, or the reverse. `url` is populated only from the trailer's `[link]` anchor, so a link inside a self post's or a comment's body stays in `selftext` and is never promoted.

It does **not** carry: **score, comment count, upvote ratio, flair, edited state, awards, or crosspost info.** None of it. There is no flag that adds them.

The consequences, which are easy to get wrong:

- **You cannot rank posts yourself.** You can only ask Reddit to rank them, with `top.rss?t=…` or `hot.rss`, and take the order it returns. Order in a `new` feed is chronological and says nothing about reception.
- **Never report or imply a score you did not see.** "This was heavily upvoted" is a fabrication unless you opened the thread. If the analysis needs engagement weight, say the data does not support it.
- **Prominence in `top` is the only popularity signal available**, and it is coarse. Use it as "Reddit ranked this highly in this window," never as a number.

## Reading The Data Honestly

Whatever you feed this into, the same three things are true of the data and none of them are visible once it is JSONL.

- **Separate what was demonstrated from what was asserted.** Someone posting their actual config, a transcript, or a reproducible failure is showing you something — the strongest material a subreddit offers. Someone saying what they think ought to be true is asserting, and that is far weaker: it is performed for an audience and a voting algorithm on top of that. A thread blends the two sentence by sentence, so tag every signal with which it was. When it is arguable, call it asserted.
- **Selection bias is severe and one-directional.** People post when something breaks, or when they are promoting something. A subreddit over-represents both, and `top` additionally over-represents whatever was enjoyable to agree with. Silence is not contentment, and volume is not prevalence.
- **A poster is not a user you spoke to.** Nobody in a thread was asked your question, so nothing here answers it directly, and a pseudonymous account should not become a person in your records. Attribute to the thread with its permalink, every time, and never let a quote get promoted into "a user told us."

## Decision Rules

- **RSS first, and usually RSS only.** It is public, unauthenticated, stable in shape, and carries full self-post bodies. Exhaust it before considering anything else.
- **`.json` endpoints are not an option.** Verified 2026-09-19: `/r/<sub>/new.json` returns `HTTP 403` with a ~190KB HTML block page for an unauthenticated client. Do not retry it, and do not read the block page as data.
- **`old.reddit.com` is a trap, not a fallback.** It redirects (`302`, verified 2026-09-19), and it is the one surface Reddit has said it intends to restrict: in [an August 2026 post](https://www.reddit.com/r/u_spez/comments/1vgbkge/modernizing_reddits_infrastructure_with_you/), Reddit's CEO named scraping as the reason and floated limiting Old Reddit to logged-in users, alongside restricting the public API. Building a fallback on the surface whose announced reason for removal is the thing you are doing is how tooling rots between one use and the next.
- **If the ask needs scale or scores, stop and put it to whoever asked.** The honest options are Reddit's official API with a registered app and an OAuth token (rate-limited but documented, and the only path that carries scores), or not doing it. Both are choices with consequences; make them explicit rather than quietly scraping harder.
- **Do not put this behind a product feature.** It is research tooling. A hostile, silently-failing, actively-tightening upstream is a bad thing to place behind something users depend on, and the rate limit alone rules out serving requests from it.
- **Respect the source.** Reading public posts for research is the case this is for. Do not republish post bodies wholesale, do not quote at length in anything public, and link rather than reproduce. Do not use this to find, profile or track a particular person.

## Good Defaults

- Sort: `new` for "what is happening", `top` with `t=week` or `t=month` for "what landed"
- Limit: `100` — you will often get fewer, and that is the ceiling
- Scope: name the subreddits explicitly; prefer one multi-subreddit feed (`/r/a+b+c/`) over three requests — at a minute apiece that is 1 minute instead of 3, for the same posts
- Pacing: leave `PACE=60` alone. It is measured, not guessed
- Identity: set `REDDIT_RSS_UA` once per environment
- Output: `$WORK/posts.jsonl` — scratch files, never inside a checkout

## Output Standard

Report:
- Which feeds were fetched, and **how many entries each actually returned** versus the limit requested
- Any feed that failed, named as what it was — **rate-limited**, **blocked**, or **genuinely empty** — never blurred into "couldn't get it"
- The answer to what was asked, with permalinks, or the JSONL path if the data itself was the point
- For each signal surfaced: whether it was **demonstrated** or **asserted**
- An explicit note that **no scores or comment counts exist in this data**, whenever the analysis touches on what was popular
