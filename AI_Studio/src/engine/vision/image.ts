/**
 * Getting a screenshot ready for a model: read its size, shrink it to a bounded size, refuse what is still too big.
 * Shrinking uses the browser we already have (a canvas), so no image library is needed.
 */
import type { Browser } from "playwright";
import { VISION_MAX_BYTES, VISION_MAX_EDGE } from "./verdict.js";

export class VisionImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VisionImageError";
    }
}

export interface PreparedImage {
    data: Buffer;
    mediaType: "image/png" | "image/jpeg";
    width: number;
    height: number;
    /** True when the picture was shrunk before sending. */
    downscaled: boolean;
    /** Bytes before shrinking. */
    originalBytes: number;
}

/** Width and height from a PNG or JPEG header, or undefined if it is neither. */
export function imageInfo(buf: Buffer): { mediaType: "image/png" | "image/jpeg"; width: number; height: number } | undefined {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
        return { mediaType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = buf[i + 1]!;
            // Start-of-frame markers (not DHT 0xC4, JPG 0xC8, DAC 0xCC) carry the size.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { mediaType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
            }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
                continue;
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
    }
    return undefined;
}

/** Re-encode as JPEG with the longest side at most `maxEdge`, in a throwaway page of `browser`. */
async function shrink(browser: Browser, data: Buffer, mediaType: string, maxEdge: number): Promise<Buffer> {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        const b64 = await page.evaluate(
            async ({ b64, mediaType, maxEdge }) => {
                const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
                const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL("image/jpeg", 0.72).split(",")[1]!;
            },
            { b64: data.toString("base64"), mediaType, maxEdge },
        );
        return Buffer.from(b64, "base64");
    } finally {
        await context.close().catch(() => undefined);
    }
}

/**
 * The image as it will be sent. Anything larger than `maxEdge` (or than the byte ceiling) is shrunk to a JPEG; an image that
 * cannot be made small enough is refused (never sent truncated).
 */
export async function prepareImage(browser: Browser | undefined, data: Buffer, opts: { maxEdge?: number; maxBytes?: number } = {}): Promise<PreparedImage> {
    const maxEdge = opts.maxEdge ?? VISION_MAX_EDGE;
    const maxBytes = opts.maxBytes ?? VISION_MAX_BYTES;
    const info = imageInfo(data);
    if (!info) throw new VisionImageError("the screenshot is not a PNG or JPEG picture");
    const edge = Math.max(info.width, info.height);
    let out = data;
    let downscaled = false;
    if (edge > maxEdge || data.length > maxBytes) {
        if (!browser) throw new VisionImageError(`the screenshot (${info.width}x${info.height}, ${Math.round(data.length / 1024)} KB) is too large to send and there is no browser to shrink it`);
        out = await shrink(browser, data, info.mediaType, Math.min(maxEdge, edge));
        downscaled = true;
    }
    const after = imageInfo(out);
    if (!after) throw new VisionImageError("the shrunken screenshot could not be read");
    if (out.length > maxBytes) throw new VisionImageError(`the screenshot is still ${Math.round(out.length / 1024)} KB after shrinking (limit ${Math.round(maxBytes / 1024)} KB)`);
    return { data: out, mediaType: after.mediaType, width: after.width, height: after.height, downscaled, originalBytes: data.length };
}
