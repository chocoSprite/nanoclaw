/**
 * Local audio transcription via WhisperX (faster-whisper + pyannote diarization
 * + wav2vec2 alignment). Spawns `scripts/transcribe-whisperx.py` inside a
 * Python venv at `data/whisperx-venv/`.
 *
 * Requirements:
 *   data/whisperx-venv/bin/python3            — venv with `whisperx` installed
 *   scripts/transcribe-whisperx.py            — wrapper
 *   .env: HF_TOKEN=hf_...                     — HuggingFace token (pyannote terms agreed)
 *
 * Language: forced to Korean (--language ko). Output format:
 *   [MM:SS SPEAKER_XX] text
 *
 * The wrapper emits stderr `PROGRESS stage=<load|transcribe|align|diarize|error>
 * [t=MM:SS]` lines; we forward stage+time to the caller via TranscribeProgress.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const PYTHON_BIN = path.join(DATA_DIR, 'whisperx-venv', 'bin', 'python3');
const SCRIPT_PATH = path.resolve(
  process.cwd(),
  'scripts',
  'transcribe-whisperx.py',
);
const HF_HOME = path.join(DATA_DIR, 'hf-cache');
const TRANSCRIBE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

export const AUDIO_MIMETYPES = new Set([
  'audio/mpeg', // mp3
  'audio/mp4', // m4a
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'audio/aac',
  'audio/x-m4a',
  'audio/x-wav',
  'audio/opus',
]);

export function isAudioMimetype(mime: string): boolean {
  return AUDIO_MIMETYPES.has(mime);
}

// Cache availability check (evaluated on first call)
let whisperxAvailable: boolean | null = null;
let hfTokenCache: string | null = null;

function loadHfToken(): string | null {
  if (hfTokenCache !== null) return hfTokenCache;
  const env = readEnvFile(['HF_TOKEN']);
  hfTokenCache = env.HF_TOKEN || '';
  return hfTokenCache || null;
}

export function isWhisperXAvailable(): boolean {
  if (whisperxAvailable !== null) return whisperxAvailable;

  if (!fs.existsSync(PYTHON_BIN)) {
    logger.warn(
      { pythonBin: PYTHON_BIN },
      'WhisperX venv not found — audio transcription disabled. Setup: python3 -m venv data/whisperx-venv && data/whisperx-venv/bin/pip install whisperx',
    );
    whisperxAvailable = false;
    return false;
  }
  if (!fs.existsSync(SCRIPT_PATH)) {
    logger.warn({ scriptPath: SCRIPT_PATH }, 'WhisperX wrapper script missing');
    whisperxAvailable = false;
    return false;
  }
  if (!loadHfToken()) {
    logger.warn(
      'HF_TOKEN missing in .env — WhisperX diarization will fail. Get one at https://huggingface.co/settings/tokens and agree to pyannote terms',
    );
    whisperxAvailable = false;
    return false;
  }
  whisperxAvailable = true;
  return whisperxAvailable;
}

export interface TranscribeProgress {
  percent: number;
  currentTime?: string;
  totalTime?: string;
}

// Threshold for detecting whisper hallucination loops: if the same non-empty
// line appears this many times in a row, we treat the rest of the file as
// degenerate output and truncate. 10 is safely above natural Korean repetition
// (e.g. rapid "네. 네. 네." agreement, which rarely exceeds 3–5 in a row).
// WhisperX rarely produces these loops (diarization timestamps make exact-line
// repetition unlikely), but we keep the post-process as defense-in-depth.
const LOOP_THRESHOLD = 10;

/**
 * Strip trailing whisper hallucination loops from a transcript file.
 * Detects the first run of >= LOOP_THRESHOLD consecutive identical non-empty
 * lines and truncates at that point, appending a marker so downstream
 * consumers know content was removed. Mutates the file in place.
 * Returns the number of lines removed (0 if no loop detected).
 */
export function stripTailLoops(
  txtPath: string,
  threshold = LOOP_THRESHOLD,
): number {
  const raw = fs.readFileSync(txtPath, 'utf8');
  const lines = raw.split('\n');

  let runStart = -1;
  let runValue: string | null = null;
  let runLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && line === runValue) {
      runLen++;
      if (runLen >= threshold && runStart === -1) {
        runStart = i - threshold + 1;
      }
    } else {
      if (runStart !== -1) break; // loop ended; keep the one we found
      runValue = line || null;
      runLen = line ? 1 : 0;
    }
  }

  if (runStart === -1) return 0;

  const removed = lines.length - runStart;
  const kept = lines.slice(0, runStart);
  kept.push(
    `[... ${removed} repeated lines truncated (whisper hallucination)]`,
  );
  fs.writeFileSync(txtPath, kept.join('\n'));
  return removed;
}

// Simple mutex to prevent concurrent whisper processes
let transcribing = false;
const waitQueue: Array<() => void> = [];

function acquireLock(): Promise<void> {
  if (!transcribing) {
    transcribing = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      transcribing = true;
      resolve();
    });
  });
}

function releaseLock(): void {
  transcribing = false;
  const next = waitQueue.shift();
  if (next) next();
}

const PROGRESS_RE = /^PROGRESS stage=(\w+)(?: t=(\d{2}:\d{2}))?/;

/**
 * Transcribe an audio file using the WhisperX Python wrapper.
 * Returns the path to the transcript .txt file, or null on failure.
 */
export async function transcribeAudio(
  audioPath: string,
  onProgress?: (progress: TranscribeProgress) => void,
): Promise<string | null> {
  if (!isWhisperXAvailable()) return null;

  // Check file size
  const stat = fs.statSync(audioPath);
  if (stat.size > MAX_FILE_SIZE) {
    logger.warn(
      { audioPath, size: stat.size },
      'Audio file too large for transcription',
    );
    return null;
  }

  // Output file path (wrapper appends .txt to --output-prefix)
  const outputPrefix = audioPath.replace(/\.[^.]+$/, '');
  const outputPath = `${outputPrefix}.txt`;

  // Cache: skip if transcript already exists
  if (fs.existsSync(outputPath)) {
    logger.info({ audioPath, outputPath }, 'Transcript cache hit');
    return outputPath;
  }

  await acquireLock();

  try {
    // Double-check cache after acquiring lock
    if (fs.existsSync(outputPath)) {
      logger.info(
        { audioPath, outputPath },
        'Transcript cache hit (post-lock)',
      );
      return outputPath;
    }

    logger.info({ audioPath }, 'Starting audio transcription (WhisperX)');

    const hfToken = loadHfToken();
    if (!hfToken) {
      logger.warn('HF_TOKEN lost between availability check and spawn');
      return null;
    }

    return await new Promise<string | null>((resolve) => {
      const args = [
        SCRIPT_PATH,
        audioPath,
        '--output-prefix',
        outputPrefix,
        '--language',
        'ko',
      ];

      const proc = spawn(PYTHON_BIN, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          HF_TOKEN: hfToken,
          HF_HOME,
        },
      });

      let stderr = '';
      let stderrBuf = '';
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        logger.warn({ audioPath }, 'Transcription timed out');
        resolve(null);
      }, TRANSCRIBE_TIMEOUT);

      let lastProgressUpdate = 0;
      proc.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        stderr += s;
        stderrBuf += s;

        if (!onProgress) return;

        // Parse line-buffered PROGRESS updates
        let nlIdx: number;
        while ((nlIdx = stderrBuf.indexOf('\n')) !== -1) {
          const line = stderrBuf.slice(0, nlIdx);
          stderrBuf = stderrBuf.slice(nlIdx + 1);

          const match = line.match(PROGRESS_RE);
          if (!match) continue;

          const now = Date.now();
          if (now - lastProgressUpdate < 10_000) continue; // Throttle to 10s
          lastProgressUpdate = now;

          const stage = match[1];
          const t = match[2];
          const currentTime = t ? `${stage} ${t}` : stage;
          onProgress({ percent: -1, currentTime });
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (code === 0 && fs.existsSync(outputPath)) {
          const removed = stripTailLoops(outputPath);
          if (removed > 0) {
            logger.info(
              { audioPath, outputPath, removed },
              'Stripped whisper hallucination loop',
            );
          }
          logger.info({ audioPath, outputPath }, 'Transcription completed');
          resolve(outputPath);
        } else {
          logger.warn(
            { audioPath, code, stderr: stderr.slice(-1000) },
            'Transcription failed',
          );
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.warn({ audioPath, err }, 'Transcription process error');
        resolve(null);
      });
    });
  } finally {
    releaseLock();
  }
}
