/**
 * "Watch live" for an exploration on a runner (POST /api/agent/tasks/:id/explore/frame; docs/features/ux-explorer-view.md).
 *
 * The runner asks every couple of seconds whether anyone is watching (a body without `frame`, no picture taken), and only while the answer is
 * `watched: true` does it take pictures and send them here, at most one a second. The platform keeps the latest one in memory (frame-hub.ts).
 * Offered by a runner that reports `explorerFrames: true`; an older runner sends none and the page says to download the runner again.
 */
import { z } from "zod";
import { FRAME_LIMITS } from "../engine/frames/shoot.js";

/** How often the runner asks whether anyone is watching, while nobody is. */
export const EXPLORE_FRAME_POLL_MS = 2_000;
/** The body cap: the largest picture in base64 plus its facts. */
export const EXPLORE_FRAME_MAX_BYTES = Math.ceil((FRAME_LIMITS.maxBytes * 4) / 3) + 8 * 1024;

export const ExploreFrameRequest = z
    .object({
        frame: z
            .object({
                imageBase64: z.string().max(Math.ceil((FRAME_LIMITS.maxBytes * 4) / 3) + 4),
                url: z.string().max(2000),
                title: z.string().max(200),
                note: z.string().max(200),
                phase: z.enum(["exploring", "signing-in", "building"]),
                pagesSeen: z.number().int().min(0).max(1_000_000),
                at: z.string().max(40),
            })
            .strict()
            .optional(),
    })
    .strict();
export type ExploreFrameRequest = z.infer<typeof ExploreFrameRequest>;

export const ExploreFrameAnswer = z.object({ watched: z.boolean() });
export type ExploreFrameAnswer = z.infer<typeof ExploreFrameAnswer>;
