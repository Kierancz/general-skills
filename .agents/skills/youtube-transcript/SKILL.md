---
name: youtube-transcript
description: 'Pull a YouTube video''s captions to readable prose with yt-dlp, telling a genuine "no captions" apart from a bot block. Use for /youtube-transcript, "get the transcript of this video", "what did that video say about X", or mining a talk for what someone actually said.'
argument-hint: 'Example: "Get the transcript of https://www.youtube.com/watch?v=<id>"'
user-invocable: true
---

# YouTube Transcript

Fetch a YouTube video's captions with `yt-dlp` and flatten them to prose.

This is desk research against a hostile upstream. The thing that makes it work is **never mistaking a bot block for a video without captions** — the two look identical through most libraries, and the wrong call sends you chasing a transcript that was there all along.

**Self-contained.** This skill needs nothing else in the repo it sits in. The helper script lives next to this file; commands below write `$SKILL_DIR` for that directory.

```bash
SKILL_DIR=<the directory containing this SKILL.md>
```

## When To Use

- A video said something you want the text of, and re-watching it to find one passage is the alternative.
- Mining a talk or interview for the words someone actually used — their vocabulary, their objections, their workarounds.
- Reading a video someone pointed you at.

## Do Not Use

- **From a datacenter IP** — a cloud coding session, a CI runner, a VPS. YouTube blocks these. Measured 2026-08-31: one video succeeded, then every subsequent request returned `Sign in to confirm you're not a bot`, including retries and different videos. Run it from a residential connection; anywhere else, say so and stop rather than burning attempts and making the IP worse.
- **To build a corpus.** Bulk-fetching hundreds of videos is a different job with a different tool and a real proxy bill. If that is the ask, stop and put it up as a decision — see Decision Rules.
- **As a stand-in for talking to the people you actually need to hear from.** See Reading The Data Honestly.
- To fetch a video nobody named. Never go looking for "relevant videos" on your own.

## Inputs To Gather

- **Video URL or ID** — required. A full URL, a `youtu.be` short link, or a bare 11-character ID.
- **What is being looked for** — optional but useful. A rough memory of what was said narrows the read a lot.
- **Timestamps or prose** — default to prose; keep timestamps only if the moments need citing or re-watching.

## Procedure

1. **Confirm this machine can reach YouTube.**
   - If this is a datacenter IP (a cloud session, CI, a VPS), stop here and say it has to run from a residential connection. Do not attempt and retry — failed attempts make the IP worse, and the block is not something a flag fixes.

2. **Put the scratch files somewhere that is not a repo.** Captions and transcripts are working files; writing them into a checkout dirties it, and a dirty tree is what broke this repo's CI reviewer once already.
   ```bash
   WORK=$(mktemp -d)
   ```

3. **Check for `yt-dlp` and keep it current.**
   ```bash
   yt-dlp --version || pip install -U yt-dlp
   ```
   - YouTube's bot detection changes often and `yt-dlp` tracks it. A months-old build is the most common cause of a fetch that used to work. If a fetch fails, upgrade before diagnosing anything else.

4. **List what captions exist**, so a missing transcript can be told apart from a blocked one. This step is what makes step 6 possible — do not skip it.
   ```bash
   yt-dlp --list-subs --skip-download "<url>"
   ```
   - Manual captions beat automatic ones where both exist — they are punctuated and free of ASR errors.

5. **Download the captions.**
   ```bash
   yt-dlp --write-auto-sub --write-sub --sub-lang en --skip-download \
     --sub-format vtt -o "$WORK/%(id)s.%(ext)s" "<url>"
   ```
   - Prefer the manual track (`.en.vtt` from `--write-sub`) when both land.
   - For a non-English video, pass that language and say so in the output; do not silently accept a machine translation.

6. **Interpret the result before going further — this is the step that matters.**

   | What you see | What it means | What to do |
   |---|---|---|
   | A `.vtt` with content | Success | Continue |
   | `Sign in to confirm you're not a bot`, `HTTP 429`, `IpBlocked` | **Blocked** | Report as blocked. Never as "no transcript" |
   | Step 4 listed tracks but no file was written | **Blocked** | Same — captions demonstrably exist |
   | Step 4 listed no tracks at all, no errors | Genuinely no captions | Say so; transcribing the audio (Whisper or similar) is the fallback |
   | An empty or near-empty `.vtt` | **Blocked** | Empty is a block signature, not an empty video |

   **An empty result is never evidence that a video has no captions.** YouTube's block returns `HTTP 200` with a zero-byte body on some paths and an empty list on others; libraries built on that path report "no transcript found" for a video whose captions you can see in a browser. Report what actually happened, and if the cause is genuinely ambiguous, say it is ambiguous.

7. **Flatten the VTT to prose.**
   ```bash
   python3 "$SKILL_DIR/vtt-to-text.py" "$WORK/<id>.en.vtt" > "$WORK/<id>.txt"
   ```
   - Add `--keep-timestamps` to cite moments.
   - Auto-captions arrive as a rolling window that repeats each phrase two or three times; the script de-duplicates against the running tail. If the output still reads double, the input was a format other than VTT — re-fetch with `--sub-format vtt`.

8. **Read it and answer the question that was actually asked.** If one passage was wanted, find it and quote it. Do not paste a 6,000-word transcript to answer "what did they say about X."

## Reading The Data Honestly

Whatever this gets fed into, three things are true of a video and none survive into a `.txt` file.

- **Separate what was demonstrated from what was asserted.** Someone demonstrating their real workflow on screen — their terminal, their actual config, something breaking live — is showing you behaviour in context, and that is genuinely strong evidence, often stronger than what people say in interviews. The same person saying what they think ought to be true is asserting, which is far weaker: it is performed for an audience and a recommendation algorithm on top of that. A transcript blends the two sentence by sentence and the tape will not separate them for you, so tag every signal with which it was. When it is arguable, call it asserted.
- **Selection bias runs through the whole medium.** Videos get made about what is new, contentious, or good to watch. A tool with quiet, satisfied users generates no content; a frustrating one generates a lot. Volume is not prevalence.
- **A creator is not someone you spoke to.** Nobody in a video was asked your question, so nothing in it answers one directly, and a creator who has never talked to you should not end up recorded as though they had. Attribute to the video with its URL, every time, and never let a quote get promoted into "a user told us."

## Decision Rules

- **`yt-dlp` is the tool, not a transcript package.** Verified 2026-08-31: `youtube-transcript-api` and wrappers built on it (`ytfetcher`) scrape the watch page and hit `IpBlocked` where `yt-dlp` succeeds, because `yt-dlp` falls back to alternate player-API clients. `yt-dlp` also handles metadata, manual-vs-auto track selection, and age-gated videos. Do not take on a transcript library dependency to replace it.
- **If a fetch fails, upgrade `yt-dlp` first.** Then try once more. Then stop and report. Do not add proxies, cookies, or user-agent spoofing on your own initiative — cookie extraction in particular puts a logged-in YouTube account behind the request, and that is the account owner's decision, not yours.
- **If the ask is a corpus** (a channel, a playlist, "every video about X"), do not improvise it. Put the tradeoff up as a decision: `ytfetcher` plus a residential proxy pool runs roughly $1.57–5.67 per 1,000 transcripts and is a reasonable pick at that scale, but the evidence is no stronger for being plentiful. Get an explicit answer before spending anything.
- **Do not put this behind a product feature.** It is research tooling. A hostile, silently-failing upstream that needs a proxy vendor to work at all is a bad thing to place behind something users depend on.
- **Respect the source.** Reading public captions for research is the case this is for. Do not republish transcripts, and do not quote a creator at length in anything public — cite and link instead.

## Good Defaults

- Format: `vtt` (the script parses it; `srv3`/`json3` are not handled)
- Language: `en`, prose output, timestamps off
- Output: under `$WORK`, named by video id — scratch files, never inside a checkout

## Output Standard

Report:
- The video title and URL, so the source stays attributable
- Whether the captions were **manual or automatic** — auto-captions mangle tool names and jargon, which is usually exactly the vocabulary being mined
- The answer to what was asked, or the transcript path if the text itself was the point
- For each signal surfaced: whether it was **demonstrated** or **asserted**
- Any fetch failure named as what it was — **blocked** or **no captions exist** — never blurred into "couldn't get it"
