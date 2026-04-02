/**
 * Local audio transcription using whisper-cpp (whisper-cli).
 * Requires: brew install whisper-cpp
 * Model: ggml-large-v3-turbo.bin in data/models/
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const WHISPER_BIN = '/opt/homebrew/bin/whisper-cli';
const MODEL_PATH = path.join(DATA_DIR, 'models', 'ggml-large-v3-turbo.bin');
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

// Cache whisper availability check
let whisperAvailable: boolean | null = null;

export function isWhisperAvailable(): boolean {
  if (whisperAvailable !== null) return whisperAvailable;

  if (!fs.existsSync(WHISPER_BIN)) {
    logger.warn(
      { bin: WHISPER_BIN },
      'whisper-cli not found — audio transcription disabled. Install: brew install whisper-cpp',
    );
    whisperAvailable = false;
    return false;
  }
  if (!fs.existsSync(MODEL_PATH)) {
    logger.warn(
      { modelPath: MODEL_PATH },
      'whisper-cli found but model file missing',
    );
    whisperAvailable = false;
    return false;
  }
  whisperAvailable = true;
  return whisperAvailable;
}

export interface TranscribeProgress {
  percent: number;
  currentTime?: string;
  totalTime?: string;
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

/**
 * Transcribe an audio file using whisper-cli.
 * Returns the path to the transcript .txt file, or null on failure.
 */
export async function transcribeAudio(
  audioPath: string,
  onProgress?: (progress: TranscribeProgress) => void,
): Promise<string | null> {
  if (!isWhisperAvailable()) return null;

  // Check file size
  const stat = fs.statSync(audioPath);
  if (stat.size > MAX_FILE_SIZE) {
    logger.warn(
      { audioPath, size: stat.size },
      'Audio file too large for transcription',
    );
    return null;
  }

  // Output file path (whisper-cli appends .txt to the -of value)
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
      logger.info({ audioPath, outputPath }, 'Transcript cache hit (post-lock)');
      return outputPath;
    }

    logger.info({ audioPath }, 'Starting audio transcription');

    return await new Promise<string | null>((resolve) => {
      const proc = spawn(
        WHISPER_BIN,
        [
          '-m', MODEL_PATH,
          '-l', 'auto',
          '-otxt',
          '-of', outputPrefix,
          audioPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let stderr = '';
      let stdoutBuf = '';
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        logger.warn({ audioPath }, 'Transcription timed out');
        resolve(null);
      }, TRANSCRIBE_TIMEOUT);

      // Parse progress from stdout (whisper-cli outputs timestamps to stdout)
      // Lines like: [00:00:00.000 --> 00:00:07.000]  text
      let lastProgressUpdate = 0;
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();

        if (!onProgress) return;

        const lines = stdoutBuf.split('\n');
        const lastTimeLine = [...lines]
          .reverse()
          .find((l) => /\[\d{2}:\d{2}:\d{2}/.test(l));
        if (!lastTimeLine) return;

        const match = lastTimeLine.match(
          /\[(\d{2}):(\d{2}):(\d{2})\.\d+ --> (\d{2}):(\d{2}):(\d{2})\.\d+\]/,
        );
        if (!match) return;

        const now = Date.now();
        if (now - lastProgressUpdate < 10_000) return; // Throttle to 10s
        lastProgressUpdate = now;

        const endH = parseInt(match[4]);
        const endM = parseInt(match[5]);
        const endS = parseInt(match[6]);
        const currentTime = `${String(endH * 60 + endM).padStart(2, '0')}:${String(endS).padStart(2, '0')}`;

        onProgress({ percent: -1, currentTime });
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (code === 0 && fs.existsSync(outputPath)) {
          logger.info(
            { audioPath, outputPath },
            'Transcription completed',
          );
          resolve(outputPath);
        } else {
          logger.warn(
            { audioPath, code, stderr: stderr.slice(-500) },
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
