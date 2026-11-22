---
name: music-visualizer
description: 'Turn a song saved in Mossbear into a page that plays it with visuals that move to the music and, from a lyrics note the person saved, the words in time with this recording. The page is saved back to Mossbear. Use for /music-visualizer, "make a visualizer for this track", "play this song with lyrics", "sync the lyrics to this recording".'
argument-hint: 'Example: "Make a visualizer for the track in my Music bundle, with the lyrics from my note"'
user-invocable: true
metadata:
  mossbear-id: FGPCYMueY94UIIB0fcmdiQ
---

# Music Visualizer

One audio artifact in Mossbear becomes one HTML artifact in Mossbear that:

- **Plays the track.** It keeps playing with the screen off or after switching apps.
- **Moves to the music.** There are three visuals: Orbit, Skyline and Ridges.
- **Shows the lyrics in time,** if the person has a lyrics note. The current line is large over the visual, with the line before and the line after dimmed. Clicking a line jumps there, and the screen clears in instrumental breaks.
- **Lets the viewer fix the timing.** A Lyrics menu nudges the timing earlier or later, or retimes it by tapping along. The fix is kept in that browser.

The page reads the track and the note from Mossbear each time it opens. It holds no audio and no words of its own.

The scripts sit next to this file:

```bash
SKILL_DIR=<the directory containing this SKILL.md>
```

| Script | Does | Needs |
| --- | --- | --- |
| `build.py` | Fills `template.html` into the page | `python3` |
| `align.py` | Times the lyric lines to this recording by speech recognition | `ffmpeg`, `pip install faster-whisper` (the first run downloads a ~500 MB model from Hugging Face) |
| `check.cjs` | Opens the page in Chromium with a stand-in Mossbear, the real track and the real note, and reports what it shows | Node, Playwright with Chromium |

The `mossbear` CLI, signed in, downloads the track and saves the page. Lyrics timing and the browser check are optional: without them the page still plays, using the note's own timestamps or tap-along.

## Do Not Use

- **To supply the lyrics yourself.** Song lyrics are copyrighted. Never type them, copy them from a site or put them in the page. The person adds a note to Mossbear, and the page reads it. If there's no note, say so and offer to build without lyrics or wait while they add one.
- **For audio that isn't in Mossbear.** The page plays only an audio artifact it is allowed to read. Have the person upload the file first.

## Procedure

Work in the session's scratchpad. The CLI refuses paths outside the directory it runs in, so `cd` there first.

### 1. Find the track and the lyrics

- **The track.** Take a link or id the person gives. Otherwise call MCP `read` on their bundle with `kind: ["audio"]`. Confirm which track by its name and description.
- **The lyrics.** Look in the same bundle for a Markdown note with the song's words. It can hold timed lines (`[01:23.45] words`, the "LRC" format lyrics sites offer), plain lines, or both; the page prefers the timed lines. Note its id.
- **Title and subtitle.** Make these from the track's name and description, such as `You` and `Radiohead · Stockholm, Dec 1, 1995`. Ask if the name is a filename and the description says nothing.

### 2. Get local copies

```bash
cd <scratch>/<song>
mossbear artifacts pull --bundle <bundle> --kind audio --dir .
mossbear artifacts pull --bundle <bundle> --kind markdown --dir .
```

Each writes one file per artifact. Use the ones for this track and this note.

### 3. Time the lyrics to this recording

A note's timestamps are for whatever version its source timed, usually the studio album. A live or alternate recording drifts from them by seconds or minutes, and may skip or repeat parts. Time it from the audio:

```bash
python3 "$SKILL_DIR/align.py" "<track file>" "<note file>" --out . --check
```

It transcribes the track, lines the lyric words up with the heard words, and writes `timing.json` (start times in the order the page reads the lines, plus a fingerprint of those lines). With `--check` it then transcribes each line's few seconds on their own and prints `ok` or `??` beside the line and what was heard.

Read the output, then fix by hand what it got wrong:

- **`untimed`** lists lines it couldn't place. A run of several, such as a repeated chorus, is often a part this recording doesn't sing; leave those `null`. For a line that is sung, look for its words in `words-<model>.json` between the times of the lines around it.
- **`??`** means the window didn't sound like the line. Sung words are often misheard ("the waters can't sustain"), so compare sound and rhythm, not spelling. A short line ("And why") may borrow words from the next one. "Thanks for watching!" or similar in a quiet passage is the model inventing text.
- **To fix a line,** set `times[<entry>]` in `timing.json` to its start in seconds, or `null` to leave it out. A blank entry (empty text) is a break: set it shortly after the last sung word before it, and the screen clears there. Then re-check without transcribing again:

```bash
python3 "$SKILL_DIR/align.py" "<track file>" "<note file>" --out . --check-only
```

If many lines are missed, align again with `--model medium.en` (several times slower, and better at sung words). If the timing still isn't trustworthy, skip `--timing` in step 4 and tell the person to use Tap along.

### 4. Build the page

```bash
python3 "$SKILL_DIR/build.py" --track <audio id> --lyrics <note id> --timing timing.json \
  --title "<title>" --subtitle "<subtitle>" --out page.html
```

Leave out `--lyrics` and `--timing` for a page without words, and `--timing` alone to use the note's own timestamps.

### 5. Check it in a browser

```bash
node "$SKILL_DIR/check.cjs" page.html "<track file>" "<note file>" --out shots
```

It reports whether the track got ready, which timing the lyrics used (`hint`), the line on screen half a second into each timed line, and any console errors. Look at `shots/desktop.png` and `shots/phone.png`. Skip this step if Node or Playwright isn't available, and say it wasn't run.

### 6. Save it to Mossbear

A new page, filed with the track:

```bash
mossbear artifacts create --file page.html --name "<title> — visualizer" --bundle <bundle>
```

To replace an existing page, read its current version first, then:

```bash
mossbear artifacts update <page id> --file page.html --expected-version <version>
```

Then set its description with MCP `write` (`ref`, `expectedVersion`, `description`). For example: "Plays <title> with visuals that move to the music and the words from the <note name> note timed to this recording."

### 7. Report

Give the page's link. Then tell the person:

- **Before it plays,** Mossbear asks them once to let the page read the track (and the note).
- **The Lyrics menu** shows or hides the words, nudges the timing, and retimes it with Tap along. Its fixes stay in the browser they were made in.
- **What was uncertain:** say which lines you timed by hand, and which the recording leaves out.

## What the Page Is

A single HTML artifact built from `template.html`, with inline CSS and script and no network access beyond the Mossbear runtime it runs in.

- **Audio.** The audio element plays the track directly, so playback survives a locked screen or a switch to another app. The visuals read a decoded copy of the track at the current position through a small FFT of their own, and pause while the page is hidden.
- **Lyrics.** It parses the note the way `align.py` does. It uses `CONFIG.timing` only if its fingerprint matches the note's lines, so editing the note can't attach old timing to new words. With no match it falls back to the note's own timestamps, and with none of those it offers tap-along.
- **Controls.** Space plays and pauses, the arrow keys skip five seconds, `1`–`3` pick a visual, `L` shows or hides the lyrics, and Escape closes the menu or ends tap-along. It honours reduced motion.

Change the look in `template.html`, never in a saved copy. Keep `align.py`'s `parse_lyrics` and `fingerprint` in step with the template's `parseLyrics` and `hash`: a change to one without the other drops every page back to the note's own timestamps.
