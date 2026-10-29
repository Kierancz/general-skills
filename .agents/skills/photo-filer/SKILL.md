---
name: photo-filer
description: 'File photos and videos into one folder per day, YEAR/YEAR-MM-DD (e.g. 2024/2024-03-17/), by the date each was taken, using exiftool. Always writes a plan first and moves nothing until it is approved; keeps a log with undo; byte-identical duplicates go to a review folder, never deleted. Use for /photo-filer, "organize my photos", "sort my pictures by date", "my photos are a mess", "file these into date folders", "clean up this camera dump", "tidy the photos on this drive". Local files only. Not for culling bad shots, editing metadata, or moving files inside Apple Photos or Lightroom (export from those apps instead).'
argument-hint: 'Example: "File ~/Pictures/photos by date"'
user-invocable: true
---

# Photo Filer

Put every photo and video in a folder under its source folder, or a library you name, at `YEAR/YEAR-MM-DD/`, keeping its original filename.

Losing a photo is the one mistake that can't be fixed, so the tool is built to make that impossible. It writes a plan, and nothing changes until the plan is approved. It never deletes a file and never overwrites one. Every applied plan writes a log that `undo` can reverse.

**Self-contained.** It needs `python3` and `exiftool` (on macOS: `brew install exiftool`). The script lives next to this file. Commands below write `$SKILL_DIR` for that directory, and run it through `python3` so a missing executable bit does not matter.

```bash
SKILL_DIR=<the directory containing this SKILL.md>
```

## How a file gets its date

In order, first hit wins:

1. **exiftool metadata.** `DateTimeOriginal`, then QuickTime `CreationDate`, `CreateDate`, `MediaCreateDate`, then XMP `DateCreated`. QuickTime times are read as UTC and converted to local time, so a video lands on the day it was shot. Impossible dates such as `0000:00:00` are ignored.
2. **A date in the filename,** such as `IMG_20190501_123456.jpg` or `Screenshot 2024-03-17 at 10.00.00.png`. The folder is right but the time of day is unknown.
3. **A date folder it already sits in:** `2013/2013-08-10/` or the older `2013/08/10/`. Someone dated it before.
4. **Otherwise `Undated/<original subfolder>/`,** so the folder it came from still hints at what it is.

File modified times are **never** used. Copying, syncing and restoring backups rewrite them, so filing by them puts 2019 holiday photos under the day the backup was restored.

A Live Photo's `.mov` goes wherever its still goes, even if the clip's own timestamp crosses midnight. Sidecars (`.xmp`, `.aae`, `.thm` and editor files) follow their photo. A RAW+JPEG pair stays together because both carry the same timestamp.

## What it leaves alone

It reports each of these, with counts, instead of touching them:

- **App libraries and catalogs:** `*.photoslibrary`, `*.lrlibrary`, `*.lrdata`, Photo Booth, Aperture, and any folder holding a Lightroom `.lrcat`. If the source or destination is *inside* one, it refuses to run.
- **Folders a Lightroom catalog tracks.** It reads the catalog read-only and skips any file in a folder the catalog lists, because moving it would break the catalog's link. It also says when a catalog's paths no longer exist on this machine, which means its links are already broken.
- iCloud placeholders not downloaded to this Mac, symlinks, hidden files, and anything that is not a photo or video (PSD, text and so on).
- Its own `Undated/` and `_duplicates/` folders. A second run never re-files them.
- A whole home folder or a whole disk. It refuses those.

## Procedure

1. **Ask which folder,** if the user hasn't said. Ask whether to file it in place (the default) or into a separate library (`--dest`). Ask whether to move (the default) or `--copy`. Copy is the safer choice when the source is a card, a phone dump, or the only copy.

   To merge one folder into a library that already exists, plan the folder with `--dest <library>`. Photos already in the library's `YEAR/` folders are checked for duplicates under any name, and never moved. No `--exclude` list is needed to fence off the rest of the library.

2. **Plan.** This reads files and writes only a plan CSV, outside the photo folder.
   ```bash
   python3 "$SKILL_DIR/photo_filer.py" plan "<folder>" [--dest "<library>"] [--copy] [--exclude "<subfolder>"]...
   ```
   If a Lightroom catalog outside the folder manages any of it, add `--catalog "<path.lrcat>"`. Large folders take a while, because exiftool reads every file and same-size files are hashed. Run it in the background past a few thousand files.

3. **Walk the user through the summary** before anything else. Lead with what they can't see for themselves:
   - **How many are undated or dated only by filename.** Those are the ones a date sort gets wrong.
   - **WILL FAIL lines, first.** The plan checks every folder and file it has to change. A folder with a macOS deny rule (an ACL, often left by an old backup or Aperture "locked" folder) or a locked (`uchg`) file is named with the files it blocks. Unlocking changes the user's permissions, so ask before running the `chmod -N` / `chflags nouchg` it suggests, then re-plan.
   - **Duplicates:** the count and the space they take. In move mode they go to `_duplicates/<original subfolder>/` for review. In copy mode they are only listed, since the original stays put. The kept copy is one already in the library, then the one already filed, then the one with the best date, then the one whose name doesn't look like a copy (`copy`, `(1)`, ` 2`).
   - **Folders this empties.** An event folder such as `Hayden backpacking/` loses its name once its photos move into date folders, and the date folders don't carry it. Name those folders and ask whether to file them anyway or `--exclude` them. Never decide this for the user. Folders named only by date or number (`2013/08/10`) aren't listed; nothing is lost with them.
   - **Catalog notes,** and anything else listed under "left alone".
   - **A few example moves.** The full plan CSV path is printed; offer to show more rows from it.

4. **Apply only after a clear yes to that plan.**
   ```bash
   python3 "$SKILL_DIR/photo_filer.py" apply "<plan.csv>"
   ```
   It does exactly what the plan says, in order. It re-checks every file first, and any file whose size or modified time changed since the plan is left alone and marked failed. Moves on the same volume are renames. Across volumes, and for `--copy`, it copies, checks the SHA-256 against the original, and only then removes the source (or keeps it, with `--copy`). Before starting, it checks there is enough free space. A plan can only be applied once.

5. **Report from the apply output:** counts per action, any failures with their reasons, the log path and the exact `undo` command. Then suggest the user open a few date folders to check.

   If rows failed, read the reasons in the log. Once the cause is fixed (with the user's OK if it means unlocking something), try only those rows again. It writes a new plan from the failed rows and applies it, re-checking each file:
   ```bash
   python3 "$SKILL_DIR/photo_filer.py" apply "<log.csv>" --retry
   ```

   A move leaves the old folders empty, apart from Finder's hidden `.DS_Store`. Offer to remove them; preview first, and `--run` only on a yes. It touches only folders inside the filed source that the log moved files out of, and only when nothing but `.DS_Store` is left:
   ```bash
   python3 "$SKILL_DIR/photo_filer.py" prune "<log.csv>"
   ```

6. **Undo** if they want it back:
   ```bash
   python3 "$SKILL_DIR/photo_filer.py" undo "<log.csv>"          # preview
   python3 "$SKILL_DIR/photo_filer.py" undo "<log.csv>" --run
   ```
   Undoing moves puts each file back where it was and removes the date folders it emptied. Undoing a copy removes only the copies that still match their untouched originals.

Plans and logs go to `${XDG_STATE_HOME:-~/.local/state}/photo-filer/` unless `--plan` says otherwise.

## Decision rules

- **Never apply a plan the user hasn't seen,** and never re-plan and apply in one step. A new plan is a new approval.
- **Never delete anything to "finish the job".** That includes duplicates, `_duplicates/`, and files the tool left alone. Tell the user where things are, and let them delete. `prune` is the one exception, and only after the user says yes to its preview.
- **Never unlock on your own.** A WILL FAIL line names a lock or permission rule the user set, or inherited. Show it, and change it only on their say-so.
- **Don't file inside an app's library.** For Apple Photos, export first (Photos ▸ File ▸ Export, or `osxphotos export`) to a plain folder, then file that folder. For Lightroom, move folders from inside Lightroom so its catalog follows.
- **Don't guess dates or event names.** An undated file stays undated. A folder name is the user's to keep or drop.
- **A failure is not a retry loop.** Read the reason in the log. A changed file needs a fresh plan; a full disk needs space; anything else, report it.

## Output Standard

After planning, report the counts per action, what dated the files (exif, quicktime, filename, none), the duplicate count and size, the folders it empties, the catalog notes, the plan path, and the question to approve.

After applying, report done and failed counts per action, the log path, and the undo command. For failures, add the reason and the `--retry` command. For a move, offer `prune`.
