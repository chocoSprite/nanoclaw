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
import { transcriptionEvents } from './transcription-events.js';

const PYTHON_BIN = path.join(DATA_DIR, 'whisperx-venv', 'bin', 'python3');
const SCRIPT_PATH = path.resolve(
  process.cwd(),
  'scripts',
  'transcribe-whisperx.py',
);
const HF_HOME = path.join(DATA_DIR, 'hf-cache');
// Bumped from 60m → 120m (2026-04-21): 52-min audio (F0AU4K2KYG6) timed out at
// 60m boundary. Multi-speaker pyannote 3.1 diarization on CPU scales super-
// linearly with duration — ~25m for a 30-min file is typical, so 60-min audio
// can realistically need 90m+. 120m covers up to ~60-min real time.
const TRANSCRIBE_TIMEOUT = 120 * 60 * 1000; // 120 minutes
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

// Compute type: float32 on M4 Pro CPU is comparable or faster than int8
// (Apple Silicon has strong FP32 perf; int8 dequant/requant adds overhead on
// some ops). Higher precision also produces slightly more natural segmentation
// and fewer hallucinations. Tradeoff: silence-leak artifact at audio start
// when the recording begins with silence — mitigated by stripHeadLoops below.
const COMPUTE_TYPE = 'float32';

// Domain vocabulary fed to faster-whisper as `initial_prompt`. Primes the
// decoder to recognize company-specific terms, product names, employee names,
// and advertising jargon that would otherwise be mis-transcribed (e.g.
// "꿀"→"콜", "지면"→"지명", "만능티켓"→"맞는 티켓", "더블부스터"→"더블 몬스터").
// Keep under ~224 Whisper tokens (~600 chars). See reference_company_products
// and reference_team_roster memories for source terms.
const WHISPER_INITIAL_PROMPT = [
  '보상, 퀴즈, 만보기, 유저, 마이비, 원셀프월드, 지면, 부스터, 온보딩',
  'TIPS, ADCHAIN, 애드체인, 배너, 지표, 꿀, 위젯, 포토위젯, 로그로스',
  '비기너, 넛지, 바텀시트, 취향투표, 취향티켓, 만능티켓, 라이브지면, 광고지면',
  'CPI, CPS, RV, IV, SSP, KPI, DAU, MAU, APL, MAF',
  'KOLAS, 카카오골프, 구노, 와이즈버즈, IM뱅크, 챌린저스',
  'Cho, James, Ken, Alex, Amy, Henry, Emily, Teddy, Peter, Jason',
  'Luke, Sean, Sem, Victor, Jun, Nate, Jaden, Anna, Pitt',
  '포스트백, 콜백, 애드조, 애드팝콘, 트래커로그, 네이티브, 인터스티셜, 인벤토리',
  '락스크린, 스피드부스터, 더블부스터, 프리패스, 트랜잭션',
].join(', ');

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

// Regex for a transcript line: `[MM:SS SPEAKER_XX] text`. Anchored; we strip
// the timestamp+speaker prefix and keep the trailing text for inspection.
const SEGMENT_LINE_RE = /^\[\d{2}:\d{2}\s+\S+\]\s*(.+?)\s*$/;

/**
 * Strip the head silence-leak hallucination — an artifact where float32
 * compute combined with `initial_prompt` causes the decoder to emit a short
 * repetition of prompt-adjacent tokens during the leading silence of a
 * recording (e.g. "프리패스, 프리패스" or "스포츠, 스포츠, 스포츠").
 *
 * Conservative: only strips the FIRST segment line, and only when its text is
 * 2–5 tokens of the same word repeated (comma-separated). Normal first lines
 * like "감사합니다." or "3분 30초" are unaffected.
 * Returns 1 if stripped, 0 otherwise.
 */
export function stripHeadLoops(txtPath: string): number {
  const raw = fs.readFileSync(txtPath, 'utf8');
  const lines = raw.split('\n');

  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return 0;

  const match = lines[firstIdx].match(SEGMENT_LINE_RE);
  if (!match) return 0;

  const words = match[1]
    .split(/[,\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length < 2 || words.length > 5) return 0;

  const first = words[0];
  if (!words.every((w) => w === first)) return 0;

  lines.splice(firstIdx, 1);
  fs.writeFileSync(txtPath, lines.join('\n'));
  return 1;
}

// Simple mutex to prevent concurrent whisper processes
let transcribing = false;
const waitQueue: Array<() => void> = [];

function acquireLock(audioPath: string, sizeBytes: number): Promise<void> {
  if (!transcribing) {
    transcribing = true;
    return Promise.resolve();
  }
  // Somebody else is already running whisper. Log the wait so the
  // dashboard/LogsPage can show "queued behind N in-flight" instead of
  // a silent delay before `Starting audio transcription`.
  const queuePosition = waitQueue.length + 1;
  logger.info(
    { audioPath, queueLen: queuePosition },
    'Transcription waiting for lock',
  );
  transcriptionEvents.emit({
    kind: 'transcription.queued',
    id: audioPath,
    audioPath,
    sizeBytes,
    queuePosition,
    ts: new Date().toISOString(),
  });
  return new Promise((resolve) => {
    waitQueue.push(() => {
      transcribing = true;
      logger.info({ audioPath }, 'Transcription lock acquired');
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

  await acquireLock(audioPath, stat.size);

  const startedAtMs = Date.now();

  try {
    // Double-check cache after acquiring lock
    if (fs.existsSync(outputPath)) {
      logger.info(
        { audioPath, outputPath },
        'Transcript cache hit (post-lock)',
      );
      return outputPath;
    }

    logger.info(
      { audioPath, sizeMB: Number((stat.size / 1_048_576).toFixed(1)) },
      'Starting audio transcription (WhisperX)',
    );
    transcriptionEvents.emit({
      kind: 'transcription.started',
      id: audioPath,
      audioPath,
      sizeBytes: stat.size,
      ts: new Date().toISOString(),
    });

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
        '--compute-type',
        COMPUTE_TYPE,
        '--initial-prompt',
        WHISPER_INITIAL_PROMPT,
      ];

      const proc = spawn(PYTHON_BIN, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          HF_TOKEN: hfToken,
          HF_HOME,
          // torchcodec 0.7.x (whisperx's pinned range) ships against FFmpeg
          // 4-7 libs — point its @rpath loader at keg-only ffmpeg@7 so the
          // system's ffmpeg 8 (libavutil.60) doesn't mismatch.
          DYLD_FALLBACK_LIBRARY_PATH: [
            '/opt/homebrew/opt/ffmpeg@7/lib',
            process.env.DYLD_FALLBACK_LIBRARY_PATH,
          ]
            .filter(Boolean)
            .join(':'),
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

        // Parse line-buffered PROGRESS updates. These drive both the
        // per-message Slack typing indicator (onProgress callback) and
        // the LogsPage observability trail — without a trail, a 30-min
        // whisper run looks identical to a stuck process.
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
          logger.info(
            { audioPath, stage, t: t ?? null },
            'Transcription progress',
          );
          transcriptionEvents.emit({
            kind: 'transcription.progress',
            id: audioPath,
            stage,
            ...(t ? { t } : {}),
            ts: new Date().toISOString(),
          });
          if (onProgress) {
            const currentTime = t ? `${stage} ${t}` : stage;
            onProgress({ percent: -1, currentTime });
          }
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAtMs;

        if (code === 0 && fs.existsSync(outputPath)) {
          const headRemoved = stripHeadLoops(outputPath);
          if (headRemoved > 0) {
            logger.info(
              { audioPath, outputPath },
              'Stripped head silence-leak hallucination',
            );
          }
          const tailRemoved = stripTailLoops(outputPath);
          if (tailRemoved > 0) {
            logger.info(
              { audioPath, outputPath, removed: tailRemoved },
              'Stripped tail whisper hallucination loop',
            );
          }
          logger.info({ audioPath, outputPath }, 'Transcription completed');
          transcriptionEvents.emit({
            kind: 'transcription.completed',
            id: audioPath,
            outputPath,
            durationMs,
            ts: new Date().toISOString(),
          });
          resolve(outputPath);
        } else {
          logger.warn(
            { audioPath, code, stderr: stderr.slice(-1000) },
            'Transcription failed',
          );
          transcriptionEvents.emit({
            kind: 'transcription.failed',
            id: audioPath,
            code,
            error: stderr.slice(-500) || undefined,
            durationMs,
            ts: new Date().toISOString(),
          });
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAtMs;
        logger.warn({ audioPath, err }, 'Transcription process error');
        transcriptionEvents.emit({
          kind: 'transcription.failed',
          id: audioPath,
          code: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs,
          ts: new Date().toISOString(),
        });
        resolve(null);
      });
    });
  } finally {
    releaseLock();
  }
}
