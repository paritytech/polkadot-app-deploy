/**
 * Minimal terminal spinner with an elapsed-time readout.
 *
 * Renders `⠙ <label>… (3s)` on a single line via carriage-return redraw, in the
 * style of Claude Code's live status. Built for awaiting a single async op
 * (e.g. polling on-chain authorization during login).
 *
 * Footgun-safe by design:
 *  - the redraw interval is .unref()'d, so it never keeps the Node event loop
 *    alive — callers that process.exit() still exit cleanly.
 *  - stop() is idempotent and always clears the interval.
 *  - in a non-TTY (CI / piped output) it prints one static line and no \r
 *    animation, so logs stay clean.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

export interface Spinner {
    /** Stop the spinner, clear the line, and optionally print a final line. */
    stop(finalLine?: string): void;
}

export function startSpinner(
    label: string,
    stream: NodeJS.WriteStream = process.stdout,
): Spinner {
    const start = Date.now();

    if (!stream.isTTY) {
        stream.write(`   ${label}…\n`);
        let stopped = false;
        return {
            stop(finalLine?: string) {
                if (stopped) return;
                stopped = true;
                if (finalLine) stream.write(`${finalLine}\n`);
            },
        };
    }

    let frame = 0;
    const render = () => {
        const elapsed = Math.round((Date.now() - start) / 1000);
        // \r to column 0, write the frame, then \x1b[K clears to end-of-line in
        // case this frame is shorter than the previous one.
        stream.write(`\r   ${FRAMES[frame % FRAMES.length]} ${label}… (${elapsed}s)\x1b[K`);
        frame++;
    };
    render();
    const interval = setInterval(render, FRAME_MS);
    interval.unref(); // never let the redraw timer hold the process open

    let stopped = false;
    return {
        stop(finalLine?: string) {
            if (stopped) return;
            stopped = true;
            clearInterval(interval);
            stream.write("\r\x1b[K"); // clear the spinner line
            if (finalLine) stream.write(`${finalLine}\n`);
        },
    };
}
