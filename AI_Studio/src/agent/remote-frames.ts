/**
 * "Watch live" for an exploration on this runner: the FrameTarget the engine's frame sink (engine/frames/sink.ts) gives pictures to.
 *
 * `wanted()` is what the platform last said: it is asked every EXPLORE_FRAME_POLL_MS with an empty body (no picture is taken for that), and every
 * picture's answer says it again. While nobody watches, the sink takes no picture at all. A picture is sent only when none is on its way, and a
 * failed send is dropped: a picture is never sent twice, kept or written anywhere.
 */
import { EXPLORE_FRAME_POLL_MS, ExploreFrameAnswer, type ExploreFrameRequest } from "../agent-protocol/explore-frame.js";
import type { ExplorerFrame, FrameTarget } from "../engine/frames/sink.js";
import type { ExplorePost } from "./explore-transport.js";

export interface RemoteFrameTarget extends FrameTarget {
    /** Pictures handed to the platform (a test reads it). */
    readonly sent: number;
    stop(): void;
}

export function remoteFrameTarget(o: { post: ExplorePost; signal: AbortSignal; pollMs?: number }): RemoteFrameTarget {
    const pollMs = o.pollMs ?? EXPLORE_FRAME_POLL_MS;
    let watched = false;
    let busy = false;
    let stopped = false;
    let sent = 0;
    let lastAsked = 0;
    let timer: NodeJS.Timeout | undefined;

    const ask = async (body: ExploreFrameRequest): Promise<void> => {
        busy = true;
        lastAsked = Date.now();
        try {
            const a = ExploreFrameAnswer.safeParse(await o.post("frame", body, { signal: o.signal }));
            watched = a.success && a.data.watched && !stopped;
        } catch {
            watched = false;
        } finally {
            busy = false;
        }
    };
    const tick = () => {
        timer = undefined;
        if (stopped || o.signal.aborted) return;
        const due = !busy && Date.now() - lastAsked >= pollMs;
        void (due ? ask({}) : Promise.resolve()).finally(() => {
            if (!stopped && !o.signal.aborted) {
                timer = setTimeout(tick, pollMs);
                timer.unref?.();
            }
        });
    };
    const stop = () => {
        stopped = true;
        watched = false;
        if (timer) clearTimeout(timer);
        timer = undefined;
    };
    o.signal.addEventListener("abort", stop, { once: true });
    tick();

    return {
        get sent() {
            return sent;
        },
        wanted: () => watched && !busy && !stopped,
        accept(f: ExplorerFrame) {
            if (!watched || busy || stopped) return;
            sent++;
            void ask({
                frame: {
                    imageBase64: Buffer.from(f.jpeg).toString("base64"),
                    url: f.url.slice(0, 2000),
                    title: f.title.slice(0, 200),
                    note: f.note.slice(0, 200),
                    phase: f.phase,
                    pagesSeen: Math.max(0, Math.min(1_000_000, Math.floor(f.pagesSeen))),
                    at: f.at.slice(0, 40),
                },
            });
        },
        stop,
    };
}
