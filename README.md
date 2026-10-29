# youtube-summary

Pull a YouTube video's transcript and summarise it with the [Codex CLI](https://github.com/openai/codex).

```bash
node summarize.mjs https://youtu.be/VIDEO_ID
```

The summary is printed as Markdown: a TL;DR, key points with timestamps, and notable claims.

## Requirements

- Node 18+
- `codex`, logged in
- [`uv`](https://docs.astral.sh/uv/), for the fallbacks. It fetches yt-dlp and faster-whisper on first use, so you don't need to install them yourself.

There are no npm dependencies. Run `npm link` to get a `yt-summary` command.

## Usage

```bash
node summarize.mjs <url-or-id> [more...] [options]
```

| Option | Description |
| --- | --- |
| `--lang <code>` | Preferred caption language (default: `en`; Whisper auto-detects) |
| `-m, --model <model>` | Codex model (default: from `~/.codex/config.toml`) |
| `-p, --prompt <text>` | Custom instructions in place of the default summary prompt |
| `-t, --transcript-only` | Print the transcript and skip Codex |
| `-o, --out <dir>` | Also write `<id>.md` (summary) and `<id>.txt` (transcript) |
| `--whisper` | Skip captions and always transcribe the audio |
| `--no-whisper` | Never fall back to transcribing the audio |
| `--whisper-model <name>` | faster-whisper model (default: `small`; e.g. `base`, `medium`, `large-v3`) |
| `--chunk-chars <n>` | Split transcripts longer than this into parts (default: `60000`) |
| `--concurrency <n>` | Parts to summarise at once (default: `2`) |

Examples:

```bash
node summarize.mjs URL1 URL2 -o summaries/
node summarize.mjs URL -t > transcript.txt
node summarize.mjs URL -p "List every tool and library mentioned"
node summarize.mjs URL --whisper --whisper-model medium
```

Progress and errors go to stderr, and the result goes to stdout. If any video fails, the exit code is 1.

## How it works

**Transcript.** Sources are tried in order until one works:

1. YouTube's internal player API (`lib/transcript.mjs`). Network errors and 429/5xx responses are retried twice.
2. yt-dlp subtitles (`lib/ytdlp.mjs`). The script uses `$YTDLP` if set, otherwise `yt-dlp` on PATH, otherwise `uvx yt-dlp`.
3. Whisper (`transcribe.py`). It downloads the audio with yt-dlp and transcribes it on the CPU with faster-whisper. The first run downloads the model (about 500 MB for `small`).

Captions written by a person are preferred over auto-generated ones.

**Summary** (`lib/codex.mjs`). The transcript, with `[mm:ss]` timestamps, is passed to `codex exec` on stdin. Codex runs read-only and ephemeral, in an empty temp dir.

Transcripts longer than `--chunk-chars` are split at line boundaries, with a small overlap between parts. Each part is summarised into notes, and a final Codex call merges the notes into one summary.

## Environment

| Variable | Description |
| --- | --- |
| `YTDLP` | Path to the yt-dlp binary to use |
| `YT_SKIP_INNERTUBE=1` | Debug: skip the internal API and go straight to yt-dlp |

## Troubleshooting

- **Internal API fails with a bot check or consent wall.** The yt-dlp fallback handles this automatically. If the API breaks for every video, try bumping `ANDROID_CLIENT.clientVersion` in `lib/transcript.mjs`.
- **Old yt-dlp on PATH fails on YouTube.** yt-dlp needs a JS runtime for YouTube since 2025.11. Update it, or set `YTDLP` to a newer copy.
- **Whisper is slow.** Use `--whisper-model base` for speed, or `medium`/`large-v3` for accuracy.
- **`open() got an unexpected keyword argument 'metadata_errors'`.** faster-whisper 1.2.1 doesn't work with recent PyAV, so `transcribe.py` pins `av<16`. Keep that pin if you change the dependencies.
