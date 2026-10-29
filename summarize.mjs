#!/usr/bin/env node
// Fetch a YouTube transcript and summarise it with the Codex CLI.
//
// Usage: node summarize.mjs <url-or-id> [more...] [options]   (see --help)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { formatLines, summarise } from './lib/codex.mjs';
import { fetchTranscript, videoId } from './lib/transcript.mjs';

const HELP = `Usage: node summarize.mjs <url-or-id> [more...] [options]

Transcripts come from YouTube captions (internal API, then yt-dlp). If a video has
no captions, its audio is downloaded and transcribed locally with Whisper.

Options:
  --lang <code>            Preferred caption language (default: en; Whisper auto-detects)
  -m, --model <model>      Codex model to use (default: gpt-6-sol)
  -e, --effort <level>     Codex reasoning effort: low, medium, high, xhigh, max (default: medium)
  -p, --prompt <text>      Custom instructions in place of the default summary prompt
  -t, --transcript-only    Print the transcript and skip Codex
  -o, --out <dir>          Also write <id>.md (summary) and <id>.txt (transcript) here
  --whisper                Skip captions and always transcribe the audio
  --no-whisper             Never fall back to transcribing the audio
  --whisper-model <name>   faster-whisper model (default: small; e.g. base, medium, large-v3)
  --chunk-chars <n>        Split transcripts longer than this into parts (default: 60000)
  --concurrency <n>        Parts to summarise at once (default: 2)

Environment:
  YTDLP=<path>             yt-dlp to use (default: yt-dlp on PATH, else uvx yt-dlp)
  YT_SKIP_INNERTUBE=1      Debug: skip the internal API and go straight to yt-dlp`;

function positiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      model: { type: 'string', short: 'm', default: 'gpt-6-sol' },
      effort: { type: 'string', short: 'e', default: 'medium' },
      prompt: { type: 'string', short: 'p' },
      'transcript-only': { type: 'boolean', short: 't', default: false },
      out: { type: 'string', short: 'o' },
      whisper: { type: 'boolean', default: false },
      'no-whisper': { type: 'boolean', default: false },
      'whisper-model': { type: 'string', default: 'small' },
      'chunk-chars': { type: 'string', default: '60000' },
      concurrency: { type: 'string', default: '2' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || !positionals.length) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (values.whisper && values['no-whisper']) throw new Error('--whisper and --no-whisper conflict');

  const chunkChars = positiveInt(values['chunk-chars'], '--chunk-chars');
  const concurrency = positiveInt(values.concurrency, '--concurrency');
  const whisper = values.whisper ? 'force' : values['no-whisper'] ? 'never' : 'auto';

  if (values.out) await mkdir(values.out, { recursive: true });
  let failed = false;

  for (const input of positionals) {
    try {
      const id = videoId(input);
      console.error(`Fetching transcript for ${id}...`);
      const t = await fetchTranscript(id, { lang: values.lang, whisper, whisperModel: values['whisper-model'] });
      const transcript = formatLines(t.lines);
      const source = `${t.source}, ${t.language}${t.auto && t.source.startsWith('captions') ? ', auto-generated' : ''}`;
      const header = `# ${t.title}\nhttps://www.youtube.com/watch?v=${id}\nTranscript: ${source}\n`;

      if (values.out) await writeFile(join(values.out, `${id}.txt`), `${header}\n${transcript}\n`);

      if (values['transcript-only']) {
        console.log(`${header}\n${transcript}\n`);
        continue;
      }

      console.error(`Summarising "${t.title}" (${t.lines.length} lines, ${source}) with Codex...`);
      const summary = await summarise(t.lines, {
        title: t.title,
        prompt: values.prompt,
        model: values.model,
        effort: values.effort,
        chunkChars,
        concurrency,
      });
      const doc = `${header}\n${summary}\n`;

      if (values.out) await writeFile(join(values.out, `${id}.md`), doc);
      console.log(doc);
    } catch (err) {
      failed = true;
      console.error(`Error (${input}): ${err.message}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
