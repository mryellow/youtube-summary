# /// script
# requires-python = ">=3.9"
# dependencies = ["faster-whisper>=1.1", "av<16"]  # faster-whisper 1.2.1 breaks on PyAV 19 (open() metadata_errors); 15.1 works
# ///
"""Transcribe an audio file with faster-whisper on the CPU.

Prints one JSON object per line: first {"language": ..., "duration": ...},
then {"start": seconds, "text": ...} for each segment.

Usage: uv run transcribe.py <audio> [--model small] [--lang en]
"""

import argparse
import json
import sys

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="small")
    parser.add_argument("--lang", default=None, help="language code; omit to auto-detect")
    args = parser.parse_args()

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(args.audio, language=args.lang, vad_filter=True)
    print(json.dumps({"language": info.language, "duration": info.duration}), flush=True)
    for seg in segments:
        text = seg.text.strip()
        if text:
            print(json.dumps({"start": round(seg.start, 2), "text": text}), flush=True)


if __name__ == "__main__":
    sys.exit(main())
