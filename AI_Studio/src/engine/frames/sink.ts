/**
 * The Explorer view's picture source: while the AI explores an application (or builds a test from a sentence) a person may watch a small picture of
 * the browser it is using. The engine calls `capture` at natural points; the sink decides whether a picture is wanted at all.
 *
 *   - Nobody watching: `capture` returns at once. No screenshot is taken, nothing costs anything.
 *   - At most one picture a second, and never while another is being taken.
 *   - The picture is small (at most 640 px wide, at most 120 KB), with password, one-time-code and card fields covered before it is taken.
 *
 * Pictures go to a `FrameTarget` (the platform keeps the latest one per job in memory, see platform/frame-hub.ts). Nothing here writes a file.
 */
import type { Page } from "playwright";
import { FRAME_LIMITS, shootPage, type Shot } from "./shoot.js";

export { FRAME_LIMITS };

export type ExplorerPhase = "exploring" | "signing-in" | "building";

/** What a person sees: the picture and the facts about it. */
export interface ExplorerFrame {
    jpeg: Uint8Array;
    url: string;
    title: string;
    /** One plain line for what just happened, built from facts (see activity.ts). */
    note: string;
    phase: ExplorerPhase;
    pagesSeen: number;
    at: string;
}

/** What the engine knows at the moment it asks for a picture. */
export interface FrameFacts {
    note: string;
    phase: ExplorerPhase;
    pagesSeen: number;
}

/** Where pictures go and whether anyone is looking. */
export interface FrameTarget {
    /** True while a person is watching this job. Asked before every picture. */
    wanted(): boolean;
    accept(frame: ExplorerFrame): void;
}

/** What the engine holds (`ctx.frames`). */
export interface FrameSink {
    capture(page: Page, facts: FrameFacts): Promise<void>;
    /**
     * Same rules for a picture that does not come from a browser (the phone explorer): `take` is only called when a picture is wanted now, and
     * returns the finished small JPEG (already covered where it must be) or null. Optional so that a double of the browser sink need not have it.
     */
    captureShot?(take: () => Promise<Shot | null>, facts: FrameFacts): Promise<void>;
    /** Would a picture be taken right now if one were offered? Lets a caller skip the cost of making one. */
    wants?(): boolean;
    /** Pictures actually taken (a test reads this to show that none are taken while nobody watches). */
    readonly captures: number;
}

export interface FrameSinkOptions {
    now?: () => number;
    /** Takes the picture; the default drives the page. A test can hand in a double. */
    shoot?: (page: Page, secrets: readonly string[]) => Promise<Shot | null>;
    /** Stored values that must never be visible in a picture (an input holding one is covered). */
    secrets?: () => readonly string[];
    /** Gap between pictures; tests shorten it, the product uses FRAME_LIMITS.minGapMs. */
    minGapMs?: number;
}

export function createFrameSink(target: FrameTarget, o: FrameSinkOptions = {}): FrameSink {
    const now = o.now ?? Date.now;
    const shoot = o.shoot ?? shootPage;
    const gap = o.minGapMs ?? FRAME_LIMITS.minGapMs;
    let lastAt = -Infinity;
    let busy = false;
    let taken = 0;
    return {
        get captures() {
            return taken;
        },
        wants() {
            return target.wanted() && !busy && now() - lastAt >= gap;
        },
        async captureShot(take, facts) {
            if (!target.wanted()) return;
            if (busy || now() - lastAt < gap) return;
            busy = true;
            lastAt = now();
            try {
                const shot = await take();
                if (!shot || shot.jpeg.byteLength > FRAME_LIMITS.maxBytes) return;
                if (!target.wanted()) return;
                taken++;
                target.accept({ jpeg: shot.jpeg, url: shot.url, title: shot.title, note: facts.note, phase: facts.phase, pagesSeen: facts.pagesSeen, at: new Date(now()).toISOString() });
            } catch {
                /* a picture that could not be made is simply not shown */
            } finally {
                busy = false;
            }
        },
        async capture(page, facts) {
            // Cheapest checks first: nobody watching, a picture just taken, one being taken.
            if (!target.wanted()) return;
            if (busy || now() - lastAt < gap) return;
            busy = true;
            lastAt = now();
            try {
                const shot = await shoot(page, o.secrets?.() ?? []);
                if (!shot) return;
                // The person may have stopped watching while the picture was being taken.
                if (!target.wanted()) return;
                taken++;
                target.accept({ jpeg: shot.jpeg, url: shot.url, title: shot.title, note: facts.note, phase: facts.phase, pagesSeen: facts.pagesSeen, at: new Date(now()).toISOString() });
            } catch {
                /* a picture that could not be taken is simply not shown; the exploration carries on */
            } finally {
                busy = false;
            }
        },
    };
}
