import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './run.mjs';

let resolved;

// Find a yt-dlp to use: $YTDLP, then yt-dlp on PATH, then `uvx yt-dlp` (fetched on demand).
async function ytdlp() {
  if (resolved) return resolved;
  const candidates = process.env.YTDLP
    ? [[process.env.YTDLP]]
    : [['yt-dlp'], ['uvx', '--from', 'yt-dlp[default]', 'yt-dlp']];
  for (const [cmd, ...prefix] of candidates) {
    try {
      const { stdout } = await run(cmd, [...prefix, '--version']);
      // yt-dlp needs a JS runtime for YouTube since 2025.11; it only looks for deno unless told otherwise.
      const js = stdout.trim() >= '2025.11' ? ['--js-runtimes', 'node'] : [];
      return (resolved = { cmd, prefix: [...prefix, ...js] });
    } catch {}
  }
  throw new Error('yt-dlp not found (install it, or install uv so it can be fetched with uvx)');
}

async function exec(args, opts) {
  const { cmd, prefix } = await ytdlp();
  return run(cmd, [...prefix, '--no-warnings', ...args], opts);
}

// Pick a subtitle track key from yt-dlp's info: manual captions first, then auto-generated.
function pickTrack(info, lang) {
  const manual = Object.keys(info.subtitles ?? {}).filter((k) => k !== 'live_chat');
  const auto = Object.keys(info.automatic_captions ?? {});
  const exact = (keys, k) => keys.find((x) => x === k);
  const prefix = (keys) => keys.find((x) => x.startsWith(lang));

  const key = exact(manual, lang) ?? prefix(manual);
  if (key) return { key, auto: false };
  // Auto captions include machine translations; "<lang>-orig" is the original-language track.
  const autoKey = exact(auto, `${lang}-orig`) ?? exact(auto, lang) ?? prefix(auto);
  if (autoKey) return { key: autoKey, auto: true };
  if (manual.length) return { key: manual[0], auto: false };
  const orig = auto.find((x) => x.endsWith('-orig'));
  return orig ? { key: orig, auto: true } : null;
}

export async function fetchInfo(id, dir) {
  await exec(['--skip-download', '--write-info-json', '-o', join(dir, '%(id)s'), `https://www.youtube.com/watch?v=${id}`]);
  return JSON.parse(await readFile(join(dir, `${id}.info.json`), 'utf8'));
}

// Download the best caption track as json3 and parse it into { start, text } lines.
export async function fetchSubtitles(id, lang, dir) {
  const info = await fetchInfo(id, dir);
  const track = pickTrack(info, lang);
  if (!track) return { info, track: null, lines: [] };

  await exec([
    '--load-info-json', join(dir, `${id}.info.json`),
    '--skip-download',
    track.auto ? '--write-auto-subs' : '--write-subs',
    '--sub-langs', track.key,
    '--sub-format', 'json3',
    '-o', join(dir, '%(id)s'),
  ]);
  const json = JSON.parse(await readFile(join(dir, `${id}.${track.key}.json3`), 'utf8'));
  const lines = (json.events ?? [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      text: e.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim(),
    }))
    .filter((l) => l.text);
  return { info, track, lines };
}

// Download the best audio-only stream into dir and return its path. Reuses the info fetchInfo() wrote.
export async function downloadAudio(id, dir) {
  await exec(['--load-info-json', join(dir, `${id}.info.json`), '-f', 'bestaudio/best', '-o', join(dir, 'audio.%(ext)s')]);
  const file = (await readdir(dir)).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
  if (!file) throw new Error('yt-dlp finished but no audio file was written');
  return join(dir, file);
}
