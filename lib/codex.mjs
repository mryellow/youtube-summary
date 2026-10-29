import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';
import { timestamp } from './transcript.mjs';

export const DEFAULT_PROMPT = `Summarise the following YouTube video transcript.
Give:
1. A one-paragraph TL;DR.
2. The key points as a bulleted list, with approximate timestamps where useful.
3. Any notable claims, figures, or recommendations.
Respond in Markdown. Do not run any commands or edit any files; just answer.`;

const CHUNK_PROMPT = (i, n, from, to) => `This is part ${i} of ${n} of a YouTube video transcript, covering ${from}–${to}.
Write dense notes on this part only: every distinct point, claim, figure, name and recommendation, each with its timestamp.
Use a bulleted list. No TL;DR, no introduction, no conclusion.
Do not run any commands or edit any files; just answer.`;

const OVERLAP_LINES = 10;
const lineLength = (l) => timestamp(l.start).length + l.text.length + 4; // "[ts] text\n"

export async function runCodex(prompt, { model, effort }) {
  const dir = await mkdtemp(join(tmpdir(), 'yt-summary-'));
  const outFile = join(dir, 'summary.md');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--color', 'never',
    '--cd', dir,
    '-o', outFile,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '-',
  ];
  try {
    await run('codex', args, { input: prompt });
    return (await readFile(outFile, 'utf8')).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function formatLines(lines) {
  return lines.map((l) => `[${timestamp(l.start)}] ${l.text}`).join('\n');
}

// Split transcript lines into chunks of about chunkChars, cutting only between lines and
// repeating the last few lines of each chunk at the start of the next for context.
function chunk(lines, chunkChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const len = lineLength(line);
    if (size + len > chunkChars && current.length > OVERLAP_LINES) {
      chunks.push(current);
      current = current.slice(-OVERLAP_LINES);
      size = current.reduce((n, l) => n + lineLength(l), 0);
    }
    current.push(line);
    size += len;
  }
  chunks.push(current);
  return chunks;
}

// Run fn over items with at most `limit` in flight, keeping results in order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Summarise a transcript. Short ones go to Codex in one prompt; long ones are split into parts,
// each part is turned into notes, and the notes are merged by a final Codex call.
export async function summarise(lines, { title, prompt = DEFAULT_PROMPT, model, effort, chunkChars = 60000, concurrency = 2, log = console.error }) {
  const codex = { model, effort };
  const transcript = formatLines(lines);
  if (transcript.length <= chunkChars) {
    return runCodex(`${prompt}\n\nTitle: ${title}\n\n<transcript>\n${transcript}\n</transcript>\n`, codex);
  }

  const parts = chunk(lines, chunkChars);
  const notes = await mapLimit(parts, concurrency, (part, i) => {
    const from = timestamp(part[0].start);
    const to = timestamp(part.at(-1).start);
    log(`Summarising part ${i + 1}/${parts.length} (${from}–${to})...`);
    return runCodex(
      `${CHUNK_PROMPT(i + 1, parts.length, from, to)}\n\nTitle: ${title}\n\n<transcript>\n${formatLines(part)}\n</transcript>\n`,
      codex,
    );
  });

  log(`Merging ${parts.length} parts...`);
  const merged = notes.map((n, i) => `<part n="${i + 1}">\n${n}\n</part>`).join('\n\n');
  return runCodex(
    `${prompt}\n\nThe video was too long to send whole, so instead of the raw transcript you are given ` +
      `timestamped notes on each consecutive part of it. Parts overlap slightly at the edges, so ignore repeated points. ` +
      `Treat the notes together as the transcript of the whole video.\n\nTitle: ${title}\n\n<notes>\n${merged}\n</notes>\n`,
    codex,
  );
}
