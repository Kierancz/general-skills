#!/usr/bin/env bash
# Fetch Reddit Atom feeds with backoff and pacing.
#
# Reddit's limiter refuses bursts and returns 429 probabilistically -- a URL that
# fails five times in a row can succeed on the next attempt. Retrying is therefore
# correct and a single 429 is not a block. See SKILL.md -> Rate Limiting.
#
#   fetch-feed.sh --preflight              # can this machine reach Reddit at all?
#   fetch-feed.sh <url> <outfile>
#   fetch-feed.sh --out-dir DIR <url> [<url> ...]
#
# Exit 0 only if every feed was fetched.

set -uo pipefail

# Override REDDIT_RSS_UA to say who you are. The default is deliberately plain:
# it identifies the tool honestly rather than impersonating a browser.
UA="${REDDIT_RSS_UA:-reddit-rss-skill/1.0 (desk research; set REDDIT_RSS_UA to identify yourself)}"
ATTEMPTS=5

# Measured 2026-09-19, single-threaded, fresh cooldown before each trial:
#   5s interval  -> 2/8 ok (both at the start, then nothing)
#   20s interval -> 3/8 ok
#   30s interval -> 3/6 ok, alternating exactly 200/429/200/429/200/429
#   60s interval -> 5/5 ok
# That alternation at 30s is a bucket refilling about once a minute, so 60s is
# the sustained rate and anything faster just buys 429s. See SKILL.md.
PACE=60 # seconds between distinct feeds

# Retrying sooner than the refill is close to useless, so the first retry
# already waits most of a minute.
BACKOFF=(30 60 120 240)

# Set in a sandboxed/cloud session, unset on a laptop. Its presence changes what
# a 403 or a dead connection can mean, so the error paths consult it.
PROXY="${HTTPS_PROXY:-${https_proxy:-}}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

preflight() {
  # Answers one question before you spend 20 minutes: can this machine reach
  # Reddit at all, and if not, which wall stopped it?
  local code cerr ccode ccerr
  if [[ -n $PROXY ]]; then
    echo "egress proxy: $PROXY (sandboxed or cloud session)"
  else
    echo "egress proxy: none (direct connection)"
  fi

  # A control host first. Without it, "reddit is unreachable" and "this machine
  # has no egress at all" look identical, and only one of them is about Reddit.
  ccode=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" \
    "https://api.github.com" 2>/dev/null)
  ccerr=$?
  if [[ $ccode == 000 ]]; then
    echo "control host (api.github.com): UNREACHABLE (curl exit $ccerr)."
    echo "  Egress is broken or blocked for everything, not just Reddit."
    echo "  Fix connectivity first; nothing here will work."
    return 1
  fi
  echo "control host (api.github.com): reachable (HTTP $ccode)"

  code=$(curl -sS -L --compressed -A "$UA" --max-time 20 \
    "https://www.reddit.com/r/programming/new.rss?limit=1" -o /dev/null -w "%{http_code}" 2>/dev/null)
  cerr=$?

  case "$code" in
    200)
      echo "reddit.com: reachable (HTTP 200). Feeds should work; pace at ${PACE}s."
      return 0
      ;;
    429)
      echo "reddit.com: reachable but rate-limited (HTTP 429)."
      echo "  That is the normal limiter, not a block. Wait ~60s and fetch."
      return 0
      ;;
    000)
      # The control host worked, so egress is fine and this is host-specific.
      echo "reddit.com: UNREACHABLE while api.github.com is fine (curl exit $cerr)."
      if [[ -n $PROXY ]]; then
        echo "  That is an allowlist denial for this host specifically. A CONNECT"
        echo "  refusal shows up as exit 56, not as HTTP 403. This skill cannot run"
        echo "  here. Report the blocked host; do not try to route around the proxy."
      else
        echo "  Reddit is blocking this client at the network level."
      fi
      return 1
      ;;
    403)
      echo "reddit.com: refused (HTTP 403) while api.github.com is fine."
      echo "  Egress works and the host resolves, so this is Reddit refusing the"
      echo "  request -- commonly a datacenter IP. No flag fixes that; run it on a"
      echo "  laptop, or decide with the user whether a proxy is worth paying for."
      return 1
      ;;
    *)
      echo "reddit.com: HTTP $code (curl exit $cerr) -- unexpected; treat as unreachable."
      return 1
      ;;
  esac
}

fetch_one() { # url outfile -> 0 ok, 1 failed
  # Downloads to a temp file and only moves it into place once the body looks
  # like a feed. A failed attempt therefore never truncates or deletes an
  # existing good file -- which matters, because a partial write here is
  # indistinguishable from an empty subreddit downstream.
  local url="$1" out="$2" code="" cerr=0 attempt delay entries tmp last_kind=unknown
  tmp=$(mktemp "${TMPDIR:-/tmp}/reddit-rss.XXXXXX") || return 1

  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    code=$(curl -sS -L --compressed -A "$UA" \
      --max-time 30 "$url" -o "$tmp" -w "%{http_code}" 2>/dev/null)
    cerr=$?

    if [[ $code == 200 ]]; then
      if [[ ! -s $tmp ]]; then
        # A 200 with an empty body is a block, not an empty subreddit. Kept
        # retryable because a truncated response looks the same, but recorded so
        # the terminal message does not call it rate limiting.
        echo "  blocked: HTTP 200 with an empty body (attempt $attempt)" >&2
        last_kind=blocked-empty
      elif ! grep -q '<feed' "$tmp" 2>/dev/null; then
        # A block page is well-formed HTML and would parse as XML downstream.
        # Not retried: waiting does not turn an HTML block page into Atom, and
        # five attempts here burn 450s and the bucket the next feed needs.
        echo "  blocked: HTTP 200 with a block page, not a feed. Not retrying." >&2
        rm -f "$tmp"
        return 1
      else
        # Reddit serves the whole feed on one line, so count occurrences, not lines.
        entries=$(grep -o '<entry>' "$tmp" 2>/dev/null | wc -l | tr -d ' ')
        mv -f "$tmp" "$out" || return 1
        echo "  ok: HTTP 200, $(wc -c <"$out" | tr -d ' ') bytes, ${entries:-0} entries (attempt $attempt)" >&2
        return 0
      fi
    else
      echo "  HTTP $code (attempt $attempt)" >&2
      last_kind="http-$code"
      case "$code" in
        000)
          # No HTTP response at all: DNS, TLS, or the egress proxy refusing
          # CONNECT. Retrying cannot open a socket that policy has closed.
          if [[ -n $PROXY ]]; then
            echo "  no response through the egress proxy at $PROXY (curl exit $cerr)." >&2
            echo "  reddit.com is likely not on this sandbox's allowlist. Report the" >&2
            echo "  blocked host -- do not try to route around the proxy." >&2
          else
            echo "  no response (curl exit $cerr) -- DNS, TLS or connectivity." >&2
          fi
          rm -f "$tmp"
          return 1
          ;;
        404)
          echo "  no such feed -- check the subreddit, user or post id. Not retrying." >&2
          rm -f "$tmp"
          return 1
          ;;
        403)
          # Reddit refuses .json to unauthenticated clients, and refuses
          # datacenter IPs outright. This branch cannot tell those apart, so it
          # names neither as the cause -- --preflight compares against a control
          # host and can.
          echo "  refused. If this is a .json URL, use .rss. Otherwise run" >&2
          echo "  --preflight: it separates 'Reddit refused us' from 'this host" >&2
          echo "  is blocked here'. Not retrying either way." >&2
          rm -f "$tmp"
          return 1
          ;;
      esac
    fi

    if ((attempt < ATTEMPTS)); then
      delay=${BACKOFF[attempt - 1]}
      echo "  backing off ${delay}s" >&2
      sleep "$delay"
    fi
  done

  rm -f "$tmp"
  # The verdict has to match what was actually seen. Calling a block
  # "rate-limited" is the blurring the skill's Output Standard forbids.
  case "$last_kind" in
    blocked-empty)
      echo "  gave up after $ATTEMPTS attempts -- every response was an empty body." >&2
      echo "  Report this as blocked. Not rate-limited, and not 'no posts'." >&2
      ;;
    http-429)
      echo "  gave up after $ATTEMPTS attempts -- rate-limited throughout, never blocked." >&2
      echo "  Try again later; do not report it as a block." >&2
      ;;
    *)
      echo "  gave up after $ATTEMPTS attempts (last seen: $last_kind)." >&2
      echo "  Report what was seen, never as 'no posts'." >&2
      ;;
  esac
  return 1
}

slug_for() { # url -> filename
  local slug
  slug=$(printf '%s' "$1" |
    sed -e 's|https\{0,1\}://||' -e 's|www\.reddit\.com/||' \
      -e 's|[^A-Za-z0-9._+-]|_|g' -e 's|__*|_|g' -e 's|^_||' -e 's|_$||')
  # Truncating alone collides: two searches over the same long multi-subreddit
  # path share their first 120 characters, and the second silently overwrote
  # the first. A checksum of the full URL keeps truncated names distinct.
  if ((${#slug} > 120)); then
    slug="${slug:0:108}-$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
  fi
  printf '%s' "$slug"
}

main() {
  local out_dir="" urls=() failed=0 first=1

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out-dir)
        out_dir="${2:-}"
        [[ -n $out_dir ]] || usage
        shift 2
        ;;
      --preflight)
        preflight
        exit $?
        ;;
      -h | --help) usage ;;
      *)
        urls+=("$1")
        shift
        ;;
    esac
  done

  ((${#urls[@]})) || usage

  # Two bare args and no --out-dir is the <url> <outfile> form.
  if [[ -z $out_dir && ${#urls[@]} -eq 2 ]]; then
    echo "fetching ${urls[0]}" >&2
    fetch_one "${urls[0]}" "${urls[1]}" || exit 1
    echo "${urls[1]}"
    exit 0
  fi

  if [[ -z $out_dir ]]; then
    [[ ${#urls[@]} -eq 1 ]] || usage
    out_dir=.
  fi
  mkdir -p "$out_dir"

  for url in "${urls[@]}"; do
    ((first)) || sleep "$PACE"
    first=0
    local out="$out_dir/$(slug_for "$url").xml"
    echo "fetching $url" >&2
    if fetch_one "$url" "$out"; then
      echo "$out"
    else
      # Nothing to clean up: fetch_one only writes $out on success, so a
      # failure here leaves any previously fetched copy intact.
      failed=$((failed + 1))
    fi
  done

  if ((failed)); then
    echo "$failed of ${#urls[@]} feed(s) failed" >&2
    exit 1
  fi
}

main "$@"
