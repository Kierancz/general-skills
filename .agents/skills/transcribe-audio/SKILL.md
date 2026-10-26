---
name: transcribe-audio
description: 'Transcribe an audio file (m4a, mp3, wav, mp4) to text using mlx-whisper on Apple Silicon. Use for call recordings, interviews, and voice memos.'
argument-hint: 'Example: "Transcribe recordings/call-2026-04-09.m4a"'
user-invocable: true
---

# Transcribe Audio

Transcribe a local audio file to text using `mlx-whisper`, an Apple MLX-native Whisper implementation with Metal GPU acceleration. Runs entirely offline on M1/M2/M3 Mac. No API key or cloud service required.

## When To Use

- Transcribing call recordings, user interviews, or voice memos in m4a, mp3, wav, mp4, or ogg format
- Producing a text transcript to feed into further analysis (e.g. `/ingest-interview`)
- Any situation where you need a local, private transcription without sending audio to an external service

## Do Not Use

- If the audio is not in a supported container format (e.g. raw PCM streams without a container) — convert to wav first
- If the audio is not English and the user has not specified a language — ask before proceeding

## Inputs To Gather

- **Audio file path** — absolute or relative path to the audio file (required)
- **Model size** — default `large-v3` for best accuracy; user may request `medium` for faster results
- **Output directory** — default to the same directory as the input file; ask if the user wants it elsewhere

## Procedure

1. **Resolve and verify the file path.**
   - If the path is relative, resolve it against the current working directory.
   - Confirm the file exists: `ls -lh "<file_path>"`. If it does not exist, stop and report the error.

2. **Check for mlx-whisper.**
   ```bash
   mlx_whisper --help > /dev/null 2>&1 && echo "installed" || echo "missing"
   ```
   - If missing, install it:
     ```bash
     pip install mlx-whisper
     ```
   - If `pip` is not found, try `pip3`. If that also fails, report the issue and stop.

3. **Inform the user about the first-run model download.**
   - On first use, `mlx-whisper` downloads the model (~3 GB for large-v3) automatically from Hugging Face into `~/.cache/huggingface/`. This only happens once.
   - Tell the user this upfront so they are not surprised by a delay or network activity.

4. **Run transcription.**
   - Determine output directory (default: same directory as input file).
   - Default model: `mlx-community/whisper-large-v3-mlx`
   - Medium model (if user requested speed): `mlx-community/whisper-medium-mlx`
   ```bash
   mlx_whisper "<file_path>" \
     --model mlx-community/whisper-large-v3-mlx \
     --output_format txt \
     --output_dir "<output_dir>"
   ```
   - Run this command and wait for it to complete. It may take 1–5 minutes for a 1-hour recording on large-v3.

5. **Read and present the transcript.**
   - The output file will be `<output_dir>/<basename>.txt` where `<basename>` is the audio filename without extension.
   - Read the full txt file and display the transcript inline in your response.
   - Report the output path so the user knows where the file was saved.

6. **Handle fallback if mlx-whisper fails.**
   - If `mlx_whisper` exits with an error (MPS failures are rare but possible), fall back to `whisper.cpp`:
     ```bash
     brew install whisper-cpp
     ffmpeg -i "<file_path>" -ar 16000 -ac 1 -c:a pcm_s16le /tmp/audio_converted.wav
     whisper-cpp --model ~/.whisper-cpp/ggml-large-v3.bin /tmp/audio_converted.wav --output-txt
     ```
   - Whisper.cpp model files must be downloaded separately from `https://huggingface.co/ggerganov/whisper.cpp`.

## Decision Rules

- **Always default to `large-v3`** unless the user explicitly asks for speed — it fits comfortably in 16 GB unified memory and produces noticeably better accuracy than medium, especially for proper nouns, technical jargon, and accented speech.
- **If the file extension is unusual** (not m4a/mp3/wav/mp4/ogg), warn the user and attempt anyway — mlx-whisper handles most containers. If it fails, ask the user to convert with `ffmpeg -i input.xyz output.wav`.
- **Do not re-download the model** — if `~/.cache/huggingface/hub/` already contains the model directory, the download step is skipped automatically.
- **Do not truncate the transcript** in your response — paste the full text. If it is very long (>500 lines), offer to write it to a file the user specifies instead of printing inline.

## Good Defaults

- Output format: `txt` (plain text, easiest to pipe into other tools)
- Output directory: same directory as the input audio file
- Model: `mlx-community/whisper-large-v3-mlx`
- Language: English (add `--language en` flag if auto-detection is unreliable)

## Output Standard

Report:
- The full transcript, printed inline
- The path of the saved `.txt` file
- Approximate duration of the audio (if reported by mlx-whisper)
- Any warnings about low-confidence passages or fallback steps taken
