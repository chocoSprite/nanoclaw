#!/usr/bin/env python3
"""
WhisperX transcription wrapper for nanoclaw.

Spawned by src/transcribe.ts. Reads HF_TOKEN + HF_HOME from env.
Writes `{output_prefix}.txt` with `[MM:SS SPEAKER_XX] text` per segment.
Emits stderr `PROGRESS stage=<load|transcribe|align|diarize|error> [t=MM:SS] [msg=...]`
lines that the Node side parses for Slack progress updates.

Runtime: CPU int8 (CTranslate2 has no MPS backend; int8 is the 2-8x faster-
whisper speedup path). batch_size=16.
"""
import argparse
import os
import sys

# PyTorch 2.6 changed `torch.load` default `weights_only` from False to True,
# which breaks pyannote checkpoint loading (contains omegaconf.ListConfig
# not in safe-globals allowlist). We trust the pyannote/* HF models and
# restore the old behavior here, before whisperx/pyannote imports torch.
import torch  # noqa: E402

_orig_torch_load = torch.load


def _torch_load_compat(*args, **kwargs):
    # Force weights_only=False — lightning_fabric passes it explicitly as
    # True, which breaks pyannote checkpoint loading. setdefault wouldn't
    # override an explicit True, so we force it.
    kwargs["weights_only"] = False
    return _orig_torch_load(*args, **kwargs)


torch.load = _torch_load_compat


def progress(stage: str, *, t: str | None = None, msg: str | None = None) -> None:
    parts = [f"PROGRESS stage={stage}"]
    if t is not None:
        parts.append(f"t={t}")
    if msg is not None:
        parts.append(f"msg={msg}")
    print(" ".join(parts), file=sys.stderr, flush=True)


def fmt_mmss(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 60:02d}:{total % 60:02d}"


def main() -> int:
    parser = argparse.ArgumentParser(description="WhisperX transcription wrapper")
    parser.add_argument("audio_path")
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--language", default="ko")
    parser.add_argument("--model", default="large-v3")
    # Quality levers — defaults preserve pre-tuning behavior (int8, beam=5).
    # Override via CLI for A/B testing.
    parser.add_argument(
        "--compute-type",
        default="int8",
        choices=["int8", "int8_float16", "float16", "float32"],
        help="CTranslate2 quantization. int8=fastest, float32=highest quality",
    )
    parser.add_argument(
        "--beam-size", type=int, default=5, help="Decoder beam width (default 5)"
    )
    parser.add_argument(
        "--batch-size", type=int, default=32, help="Transcription batch size"
    )
    parser.add_argument(
        "--initial-prompt",
        default=None,
        help="Domain vocabulary to prime the decoder (comma-separated terms, ~224 token cap)",
    )
    parser.add_argument(
        "--initial-prompt-file",
        default=None,
        help="Read initial_prompt from a file (alternative to --initial-prompt)",
    )
    parser.add_argument(
        "--condition-on-previous-text",
        default="true",
        choices=["true", "false"],
        help="Feed previous segment text into next segment (default true)",
    )
    parser.add_argument(
        "--temperatures",
        default="0.0,0.2,0.4,0.6,0.8,1.0",
        help="Comma-separated fallback temperatures, e.g. '0.0' disables fallback",
    )
    parser.add_argument(
        "--source-name",
        default=None,
        help="Original filename (before nanoclaw's epoch-prefix rename). Embedded as "
        "`# source: <name>` header at the top of the output .txt so downstream agents "
        "can extract recording datetime from patterns like YYYY-MM-DD_HH_MM_SS.mp3 "
        "even if the message tag is lost from context.",
    )
    args = parser.parse_args()

    initial_prompt = args.initial_prompt
    if args.initial_prompt_file and not initial_prompt:
        with open(args.initial_prompt_file, encoding="utf-8") as f:
            initial_prompt = f.read().strip()
    cond_prev = args.condition_on_previous_text == "true"
    temperatures = [float(x) for x in args.temperatures.split(",") if x.strip()]

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        progress("error", msg="HF_TOKEN missing")
        return 1

    # Enable MPS fallback so unsupported pyannote ops silently drop to CPU
    # instead of erroring. Needed for align + diarize on Apple Silicon.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    try:
        progress("load")
        import torch as _torch  # for MPS probe
        import whisperx  # heavy import, do after env check

        # faster-whisper (CTranslate2) has no MPS backend — CPU only.
        # M4 Pro has 10 performance cores; default thread count is 4.
        asr_device = "cpu"
        cpu_threads = 10

        # PyTorch-based steps (align + diarize) can use MPS on Apple Silicon.
        gpu_device = "mps" if _torch.backends.mps.is_available() else "cpu"

        # whisperx exposes faster-whisper knobs through asr_options.
        asr_options: dict = {
            "beam_size": args.beam_size,
            "condition_on_previous_text": cond_prev,
            "temperatures": temperatures,
        }
        if initial_prompt:
            asr_options["initial_prompt"] = initial_prompt

        model = whisperx.load_model(
            args.model,
            asr_device,
            compute_type=args.compute_type,
            language=args.language,
            threads=cpu_threads,
            asr_options=asr_options,
        )

        audio = whisperx.load_audio(args.audio_path)
        result = model.transcribe(audio, batch_size=args.batch_size)

        segments = result.get("segments") or []
        last_end = segments[-1]["end"] if segments else 0.0
        progress("transcribe", t=fmt_mmss(last_end))

        # Align — try MPS, fallback to CPU on failure
        progress("align")
        try:
            align_model, metadata = whisperx.load_align_model(
                language_code=args.language, device=gpu_device
            )
            result = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                gpu_device,
                return_char_alignments=False,
            )
        except Exception as align_exc:  # noqa: BLE001 - fall back to CPU
            print(
                f"align on {gpu_device} failed ({type(align_exc).__name__}), "
                f"retrying on cpu",
                file=sys.stderr,
                flush=True,
            )
            align_model, metadata = whisperx.load_align_model(
                language_code=args.language, device="cpu"
            )
            result = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                "cpu",
                return_char_alignments=False,
            )

        # Diarize — import from submodule (whisperx 3.4+ removed top-level re-export)
        progress("diarize")
        try:
            from whisperx.diarize import DiarizationPipeline
        except ImportError:
            DiarizationPipeline = whisperx.DiarizationPipeline  # older versions
        try:
            diarize_pipeline = DiarizationPipeline(
                model_name="pyannote/speaker-diarization-3.1",
                token=hf_token,
                device=gpu_device,
            )
            diarize_segments = diarize_pipeline(audio)
        except Exception as diar_exc:  # noqa: BLE001 - fall back to CPU
            print(
                f"diarize on {gpu_device} failed ({type(diar_exc).__name__}), "
                f"retrying on cpu",
                file=sys.stderr,
                flush=True,
            )
            diarize_pipeline = DiarizationPipeline(
                model_name="pyannote/speaker-diarization-3.1",
                token=hf_token,
                device="cpu",
            )
            diarize_segments = diarize_pipeline(audio)
        result = whisperx.assign_word_speakers(diarize_segments, result)

        # Write output — prepend a `# source: <name>` header when the original
        # Slack filename is known. Agents extract recording datetime from this
        # header (YYYY-MM-DD_HH_MM_SS.mp3 pattern) when the message tag
        # metadata is no longer in their context.
        out_path = f"{args.output_prefix}.txt"
        with open(out_path, "w", encoding="utf-8") as f:
            if args.source_name:
                f.write(f"# source: {args.source_name}\n\n")
            for seg in result.get("segments") or []:
                speaker = seg.get("speaker") or "SPEAKER_??"
                start = seg.get("start") or 0.0
                text = (seg.get("text") or "").strip()
                if not text:
                    continue
                f.write(f"[{fmt_mmss(start)} {speaker}] {text}\n")

        return 0
    except Exception as exc:  # noqa: BLE001 - top-level barrier
        # Avoid traceback.print_exc() — it triggers speechbrain lazy-import
        # side effects via linecache. Just log the exception type + message.
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        progress("error", msg=type(exc).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
