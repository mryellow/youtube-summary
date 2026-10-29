import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';
import { downloadAudio, fetchInfo, fetchSubtitles } from './ytdlp.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };
const TRANSCRIBE_PY = fileURLToPath(new URL('../transcribe.py', import.meta.url));
const RETRY_DELAYS = [1000, 3000];

export function videoId(input) {
  if (/^[\w-]{11}$/.test(input)) return input;
  const url = new URL(input);
  if (url.hostname === 'youtu.be') return url.pathname.slice(1, 12);
  const v = url.searchParams.get('v');
  if (v) return v;
  const m = url.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  if (m) return m[1];
  throw new Error(`Can't find a video ID in: ${input}`);
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function timestamp(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// An error that retrying won't fix (the video is unplayable, has no captions, etc.).
class FinalError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() that retries network errors and 429/5xx responses.
async function request(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const err = new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
      if (res.status !== 429 && res.status < 500) throw new FinalError(err.message);
      throw err;
    } catch (err) {
      if (err instanceof FinalError || attempt >= RETRY_DELAYS.length) throw err;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
}

async function fetchViaInnertube(id, lang) {
  const html = await request(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }).then((r) => r.text());

  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  if (!apiKey) throw new Error('Could not read INNERTUBE_API_KEY (consent wall or bot check?)');
  const title = decodeEntities(html.match(/<title>(.*?)(?: - YouTube)?<\/title>/)?.[1] ?? id);

  const player = await request(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId: id }),
  }).then((r) => r.json());

  const status = player.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new FinalError(`Video not playable: ${status} ${player.playabilityStatus?.reason ?? ''}`.trim());
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) throw new FinalError('No captions available for this video');

  // Prefer a manual track in the requested language, then an auto-generated one, then anything.
  const track =
    tracks.find((t) => t.languageCode === lang && t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode === lang) ??
    tracks.find((t) => t.languageCode.startsWith(lang)) ??
    tracks[0];

  const xml = await request(track.baseUrl.replace('&fmt=srv3', ''), {
    headers: { 'User-Agent': UA },
  }).then((r) => r.text());

  const lines = [...xml.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)].map(([, start, text]) => ({
    start: +start,
    text: decodeEntities(decodeEntities(text)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  }));
  if (!lines.length) throw new Error('Caption track was empty');

  return { id, title, language: track.languageCode, auto: track.kind === 'asr', source: 'captions', lines };
}

async function fetchViaYtdlp(id, lang) {
  const dir = await mkdtemp(join(tmpdir(), 'yt-subs-'));
  try {
    const { info, track, lines } = await fetchSubtitles(id, lang, dir);
    if (!track) throw new Error('No captions available for this video');
    if (!lines.length) throw new Error('Caption track was empty');
    return { id, title: info.title ?? id, language: track.key, auto: track.auto, source: 'captions (yt-dlp)', lines };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchViaWhisper(id, { model, lang, log }) {
  const dir = await mkdtemp(join(tmpdir(), 'yt-audio-'));
  try {
    const info = await fetchInfo(id, dir);
    log(`Downloading audio for ${id}...`);
    const audio = await downloadAudio(id, dir);

    log(`Transcribing with Whisper (${model}) on the CPU; the first run also downloads the model...`);
    const lines = [];
    let language = lang;
    let duration = 0;
    let nextReport = 30;
    await run('uv', ['run', '--script', TRANSCRIBE_PY, audio, '--model', model, ...(lang ? ['--lang', lang] : [])], {
      showStderr: true,
      onLine: (raw) => {
        if (!raw.trim()) return;
        const msg = JSON.parse(raw);
        if ('duration' in msg) {
          ({ language, duration } = msg);
          return;
        }
        lines.push(msg);
        if (msg.start >= nextReport) {
          log(`  transcribed ${timestamp(msg.start)} / ${timestamp(duration)}`);
          nextReport = msg.start + 30;
        }
      },
    });
    if (!lines.length) throw new Error('Whisper produced no speech');
    return { id, title: info.title ?? id, language, auto: true, source: `whisper (${model})`, lines };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Get a transcript, trying each source in turn: YouTube's internal API, yt-dlp subtitles, then
// local Whisper transcription. whisper is 'auto' (fallback only), 'force' (skip captions) or 'never'.
export async function fetchTranscript(id, { lang, whisper = 'auto', whisperModel = 'small', log = console.error } = {}) {
  const sources = [];
  if (whisper !== 'force') {
    if (!process.env.YT_SKIP_INNERTUBE) sources.push(['innertube', () => fetchViaInnertube(id, lang ?? 'en')]);
    sources.push(['yt-dlp', () => fetchViaYtdlp(id, lang ?? 'en')]);
  }
  if (whisper !== 'never') sources.push(['whisper', () => fetchViaWhisper(id, { model: whisperModel, lang, log })]);

  const failures = [];
  for (const [name, fn] of sources) {
    try {
      return await fn();
    } catch (err) {
      // Tool errors carry stderr after the first line; yt-dlp's useful part is its ERROR: line.
      const reason = err.message.match(/ERROR: (.*)/)?.[1] ?? err.message.split('\n')[0];
      failures.push(`${name}: ${reason}`);
      if (sources.at(-1)[0] !== name) log(`${name} failed (${reason}), trying the next source...`);
    }
  }
  throw new Error(`No transcript source worked:\n  ${failures.join('\n  ')}`);
}
