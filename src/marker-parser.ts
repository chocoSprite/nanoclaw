/**
 * Streaming parser for the two marker protocols that agent-runner emits on
 * stdout:
 *
 *   OUTPUT: `---NANOCLAW_OUTPUT_START---` … `---NANOCLAW_OUTPUT_END---`
 *   EVENT : `---NANOCLAW_EVENT_V1_START---` … `---NANOCLAW_EVENT_V1_END---`
 *
 * Both channels coexist in the same stream. Calls to console.log inside the
 * agent are atomic, so markers of different kinds never interleave within a
 * single emission — but a single `data` chunk from the host can straddle any
 * point in the stream. This parser buffers and slices by earliest-starting
 * complete pair; inner payloads are passed to the caller as trimmed strings
 * for JSON.parse on their side.
 *
 * Parser is host-side (outside src/dashboard/) so container-runner can depend
 * on it without coupling to the dashboard package.
 */

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
export const EVENT_START_MARKER = '---NANOCLAW_EVENT_V1_START---';
export const EVENT_END_MARKER = '---NANOCLAW_EVENT_V1_END---';

export interface MarkerParserHandlers {
  onOutput?: (jsonStr: string) => void;
  onEvent?: (jsonStr: string) => void;
}

export class StreamMarkerParser {
  private buffer = '';

  constructor(private readonly handlers: MarkerParserHandlers) {}

  /** Feed a stdout chunk. Handlers fire synchronously for each complete pair. */
  push(chunk: string): void {
    this.buffer += chunk;
    while (this.drainOne()) {
      // consume everything currently drainable
    }
  }

  /** Expose remaining buffered bytes (mostly for tests / debugging). */
  get bufferSize(): number {
    return this.buffer.length;
  }

  private drainOne(): boolean {
    const oStart = this.handlers.onOutput
      ? this.buffer.indexOf(OUTPUT_START_MARKER)
      : -1;
    const eStart = this.handlers.onEvent
      ? this.buffer.indexOf(EVENT_START_MARKER)
      : -1;

    // Choose the earliest-starting marker, if any
    let kind: 'output' | 'event' | null = null;
    if (oStart !== -1 && (eStart === -1 || oStart < eStart)) {
      kind = 'output';
    } else if (eStart !== -1) {
      kind = 'event';
    }
    if (kind === null) return false;

    const [startMarker, endMarker, handler, startIdx] =
      kind === 'output'
        ? [
            OUTPUT_START_MARKER,
            OUTPUT_END_MARKER,
            this.handlers.onOutput as (s: string) => void,
            oStart,
          ]
        : [
            EVENT_START_MARKER,
            EVENT_END_MARKER,
            this.handlers.onEvent as (s: string) => void,
            eStart,
          ];

    const endIdx = this.buffer.indexOf(
      endMarker,
      startIdx + startMarker.length,
    );
    if (endIdx === -1) return false; // incomplete — wait for more data

    const inner = this.buffer
      .slice(startIdx + startMarker.length, endIdx)
      .trim();
    // Drop prefix (non-marker noise) along with the consumed pair, matching
    // the legacy single-marker parser's behavior.
    this.buffer = this.buffer.slice(endIdx + endMarker.length);

    try {
      handler(inner);
    } catch {
      // Handlers own their own error isolation; swallow here to keep the
      // parser draining the rest of the buffer.
    }
    return true;
  }
}
