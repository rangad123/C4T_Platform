/**
 * Page thumbnails kept with an exploration (sheet #8 stage 5; owner 2026-11-21: per project, "Keep page thumbnails", on by default).
 *
 * One small picture of each page the crawl opens, taken with the Explorer view's covering (frames/shoot.ts: the fields the recorder's
 * `secretKindOfField` calls secret, and any field holding one of the project's stored secrets). Covering fails closed: a page that could not
 * be covered gets no thumbnail at all. Each picture is at most THUMBNAIL_LIMITS.maxBytes, and a run keeps at most THUMBNAIL_RUN_LIMITS of
 * them; the platform checks both again before it stores one (repo-sink.ts), as a runner's pictures arrive from another machine.
 *
 * The host stores each picture (GenerationSink.savePageThumbnail) and answers its id, which goes on the page (`thumbnail`).
 */
import type { Page } from "playwright";
import type { PageModel } from "../understanding/app-model.js";
import { shootPage, THUMBNAIL_LIMITS } from "../frames/shoot.js";

export { THUMBNAIL_LIMITS };

/** What one exploration keeps at most: so many pictures, and so many bytes in all. */
export const THUMBNAIL_RUN_LIMITS = { count: 300, bytes: 4 * 1024 * 1024 } as const;

/** The name a thumbnail is stored under: `thumb-<n>.jpg`. */
export const THUMBNAIL_NAME = /^thumb-\d{1,4}\.jpg$/;

/** Whether the bytes are a JPEG (its start marker). */
export const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export interface Thumbnailer {
    /** Takes the page's thumbnail and stores it; on success the page's `thumbnail` names it. Never throws. */
    take(page: Page, model: PageModel): Promise<void>;
    /** How many were kept, and whether the run's cap stopped any. */
    readonly kept: number;
    readonly capped: boolean;
}

export interface ThumbnailerOptions {
    /** Stores one picture; answers its id, or null when the host did not keep it. */
    save: (name: string, jpeg: Uint8Array) => Promise<string | null>;
    /** The project's stored secrets: a field holding one is covered too. */
    secrets: readonly string[];
    /** Takes the covered picture (default: frames/shoot.ts with THUMBNAIL_LIMITS); null when none could be taken or covering failed. */
    shoot?: (page: Page, secrets: readonly string[]) => Promise<Uint8Array | null>;
    limits?: { count: number; bytes: number };
}

const defaultShoot = async (page: Page, secrets: readonly string[]): Promise<Uint8Array | null> => (await shootPage(page, secrets, THUMBNAIL_LIMITS))?.jpeg ?? null;

export function createThumbnailer(o: ThumbnailerOptions): Thumbnailer {
    const shoot = o.shoot ?? defaultShoot;
    const limits = o.limits ?? THUMBNAIL_RUN_LIMITS;
    let kept = 0;
    let bytes = 0;
    let capped = false;
    return {
        get kept() {
            return kept;
        },
        get capped() {
            return capped;
        },
        async take(page, model) {
            if (kept >= limits.count || bytes >= limits.bytes) {
                capped = true;
                return;
            }
            try {
                const jpeg = await shoot(page, o.secrets);
                if (!jpeg || !isJpeg(jpeg) || jpeg.byteLength > THUMBNAIL_LIMITS.maxBytes) return;
                if (bytes + jpeg.byteLength > limits.bytes) {
                    capped = true;
                    return;
                }
                const id = await o.save(`thumb-${kept + 1}.jpg`, jpeg);
                if (!id) return;
                kept++;
                bytes += jpeg.byteLength;
                model.thumbnail = id;
            } catch {
                // No thumbnail for this page; the crawl goes on.
            }
        },
    };
}
