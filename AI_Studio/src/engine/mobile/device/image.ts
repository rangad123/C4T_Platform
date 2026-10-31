/**
 * The picture of the phone's screen the explorer shows to a person (and to the model): a small JPEG with every password field covered.
 *
 * `adb exec-out screencap -p` gives a PNG. The platform has no image library and this adds none: a PNG is decoded with Node's own zlib, the password
 * rectangles are painted over on the decoded pixels BEFORE anything is scaled or encoded (so the secret is gone from the data, not hidden by a layer),
 * the result is scaled down by averaging and written as a baseline JPEG by the small encoder below. Everything is bounded: pixel count, output size.
 */
import zlib from "node:zlib";

export interface Raster {
    width: number;
    height: number;
    /** RGB, 3 bytes per pixel, row by row. */
    rgb: Uint8Array;
}

const MAX_PIXELS = 36_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── PNG ─────────────────────────────────────────────────────────────────────

/** Decodes an 8-bit, non-interlaced PNG (gray, gray+alpha, RGB, RGBA or palette). undefined when it is anything else or damaged. */
export function decodePng(png: Buffer): Raster | undefined {
    try {
        if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
        let width = 0;
        let height = 0;
        let depth = 0;
        let colorType = 0;
        let interlace = 0;
        let palette: Buffer | undefined;
        const idat: Buffer[] = [];
        let p = 8;
        while (p + 8 <= png.length) {
            const len = png.readUInt32BE(p);
            const type = png.toString("latin1", p + 4, p + 8);
            const body = png.subarray(p + 8, p + 8 + len);
            if (body.length !== len) return undefined;
            if (type === "IHDR") {
                width = body.readUInt32BE(0);
                height = body.readUInt32BE(4);
                depth = body[8]!;
                colorType = body[9]!;
                interlace = body[12]!;
            } else if (type === "PLTE") palette = Buffer.from(body);
            else if (type === "IDAT") idat.push(Buffer.from(body));
            else if (type === "IEND") break;
            p += 12 + len;
        }
        if (width < 1 || height < 1 || width * height > MAX_PIXELS || depth !== 8 || interlace !== 0) return undefined;
        const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[colorType];
        if (!channels || (colorType === 3 && !palette)) return undefined;
        const stride = width * channels;
        const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 16 });
        if (raw.length < (stride + 1) * height) return undefined;
        const px = Buffer.alloc(stride * height);
        for (let y = 0; y < height; y++) {
            const filter = raw[y * (stride + 1)]!;
            const src = y * (stride + 1) + 1;
            const dst = y * stride;
            for (let x = 0; x < stride; x++) {
                const a = x >= channels ? px[dst + x - channels]! : 0;
                const b = y > 0 ? px[dst - stride + x]! : 0;
                const c = x >= channels && y > 0 ? px[dst - stride + x - channels]! : 0;
                let v = raw[src + x]!;
                if (filter === 1) v += a;
                else if (filter === 2) v += b;
                else if (filter === 3) v += (a + b) >> 1;
                else if (filter === 4) {
                    const pa = Math.abs(b - c);
                    const pb = Math.abs(a - c);
                    const pc = Math.abs(a + b - 2 * c);
                    v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                } else if (filter !== 0) return undefined;
                px[dst + x] = v & 255;
            }
        }
        const rgb = new Uint8Array(width * height * 3);
        for (let i = 0, n = width * height; i < n; i++) {
            const s = i * channels;
            let r: number;
            let g: number;
            let b: number;
            if (colorType === 2 || colorType === 6) [r, g, b] = [px[s]!, px[s + 1]!, px[s + 2]!];
            else if (colorType === 0 || colorType === 4) r = g = b = px[s]!;
            else {
                const k = px[s]! * 3;
                [r, g, b] = [palette![k] ?? 0, palette![k + 1] ?? 0, palette![k + 2] ?? 0];
            }
            rgb[i * 3] = r;
            rgb[i * 3 + 1] = g;
            rgb[i * 3 + 2] = b;
        }
        return { width, height, rgb };
    } catch {
        return undefined;
    }
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Writes a raster as an RGB PNG (used by tests and by anything that needs a real picture). */
export function encodePng(r: Raster): Buffer {
    const chunk = (type: string, body: Buffer): Buffer => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(body.length, 0);
        head.write(type, 4, "latin1");
        const tail = Buffer.alloc(4);
        tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
        return Buffer.concat([head, body, tail]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(r.width, 0);
    ihdr.writeUInt32BE(r.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const stride = r.width * 3;
    const raw = Buffer.alloc((stride + 1) * r.height);
    for (let y = 0; y < r.height; y++) Buffer.from(r.rgb.buffer, r.rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── covering and scaling ────────────────────────────────────────────────────

/** The flat colour a covered field is painted. */
export const COVER_RGB: readonly [number, number, number] = [48, 48, 48];

/** Paints a flat rectangle over each area (with a few pixels of margin), in place. Rectangles are [left, top, right, bottom] in this raster's pixels. */
export function coverRects(img: Raster, rects: ReadonlyArray<readonly [number, number, number, number]>, margin = 3): void {
    for (const [l, t, r, b] of rects) {
        const x0 = Math.max(0, Math.floor(l) - margin);
        const y0 = Math.max(0, Math.floor(t) - margin);
        const x1 = Math.min(img.width, Math.ceil(r) + margin);
        const y1 = Math.min(img.height, Math.ceil(b) + margin);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * img.width + x) * 3;
                img.rgb[i] = COVER_RGB[0];
                img.rgb[i + 1] = COVER_RGB[1];
                img.rgb[i + 2] = COVER_RGB[2];
            }
        }
    }
}

/** Scales down (never up) so the width is at most `maxWidth`, averaging the source pixels under each new one. */
export function scaleDown(img: Raster, maxWidth: number): Raster {
    if (img.width <= maxWidth) return img;
    const w = maxWidth;
    const h = Math.max(1, Math.round((img.height * w) / img.width));
    const out = new Uint8Array(w * h * 3);
    const sx = img.width / w;
    const sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy);
        const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx);
            const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            let r = 0;
            let g = 0;
            let b = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const i = (yy * img.width + xx) * 3;
                    r += img.rgb[i]!;
                    g += img.rgb[i + 1]!;
                    b += img.rgb[i + 2]!;
                }
            }
            const n = (y1 - y0) * (x1 - x0);
            const o = (y * w + x) * 3;
            out[o] = Math.round(r / n);
            out[o + 1] = Math.round(g / n);
            out[o + 2] = Math.round(b / n);
        }
    }
    return { width: w, height: h, rgb: out };
}

// ── JPEG (baseline, 4:4:4) ──────────────────────────────────────────────────

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

const QUANT_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QUANT_CHROMA = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

// Annex K.3 tables for luminance; all three components use them (a decoder accepts any table id for any component).
export const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
export const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
export const AC_VALUES = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
    0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** Huffman codes from the "number of codes per length" and values lists (JPEG Annex C). */
function buildCodes(counts: number[], values: number[]): Map<number, { code: number; len: number }> {
    const out = new Map<number, { code: number; len: number }>();
    let code = 0;
    let k = 0;
    for (let len = 1; len <= 16; len++) {
        for (let i = 0; i < counts[len - 1]!; i++) out.set(values[k++]!, { code: code++, len });
        code <<= 1;
    }
    return out;
}
const DC_CODES = buildCodes(DC_COUNTS, DC_VALUES);
const AC_CODES = buildCodes(AC_COUNTS, AC_VALUES);

const COS = (() => {
    const m: number[][] = [];
    for (let u = 0; u < 8; u++) {
        m.push([]);
        for (let x = 0; x < 8; x++) m[u]!.push((u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16));
    }
    return m;
})();

class BitWriter {
    private bytes: number[] = [];
    private acc = 0;
    private n = 0;
    put(code: number, len: number): void {
        this.acc = (this.acc << len) | (code & ((1 << len) - 1));
        this.n += len;
        while (this.n >= 8) {
            const b = (this.acc >> (this.n - 8)) & 255;
            this.bytes.push(b);
            if (b === 0xff) this.bytes.push(0);
            this.n -= 8;
        }
        this.acc &= (1 << this.n) - 1;
    }
    finish(): number[] {
        if (this.n > 0) this.put((1 << (8 - this.n)) - 1, 8 - this.n);
        return this.bytes;
    }
}

const sizeOf = (v: number): number => {
    let a = Math.abs(v);
    let s = 0;
    while (a) {
        s++;
        a >>= 1;
    }
    return s;
};

function scaledTable(base: number[], quality: number): number[] {
    const q = Math.max(1, Math.min(100, Math.round(quality)));
    const scale = q < 50 ? 5000 / q : 200 - q * 2;
    return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

/** Encodes the raster as a baseline JPEG. `quality` 1-100. */
export function encodeJpeg(img: Raster, quality = 60): Buffer {
    const qy = scaledTable(QUANT_LUMA, quality);
    const qc = scaledTable(QUANT_CHROMA, quality);
    const out: number[] = [];
    const u16 = (v: number) => out.push((v >> 8) & 255, v & 255);
    out.push(0xff, 0xd8);
    out.push(0xff, 0xe0);
    u16(16);
    out.push(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
    for (const [id, table] of [[0, qy], [1, qc]] as const) {
        out.push(0xff, 0xdb);
        u16(67);
        out.push(id);
        for (let i = 0; i < 64; i++) out.push(table[ZIGZAG[i]!]!);
    }
    out.push(0xff, 0xc0);
    u16(17);
    out.push(8);
    u16(img.height);
    u16(img.width);
    out.push(3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
    for (const [cls, counts, values] of [[0x00, DC_COUNTS, DC_VALUES], [0x10, AC_COUNTS, AC_VALUES]] as const) {
        out.push(0xff, 0xc4);
        u16(2 + 1 + 16 + values.length);
        out.push(cls, ...counts, ...values);
    }
    out.push(0xff, 0xda);
    u16(12);
    out.push(3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0);

    const bits = new BitWriter();
    const prevDc = [0, 0, 0];
    const block = new Float64Array(64);
    const tmp = new Float64Array(64);
    const coef = new Int32Array(64);
    const planes = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];

    const encodeBlock = (samples: Float64Array, comp: number, table: number[]): void => {
        // forward DCT, separable
        for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let x = 0; x < 8; x++) s += samples[y * 8 + x]! * COS[u]![x]!;
            tmp[y * 8 + u] = s;
        }
        for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let y = 0; y < 8; y++) s += tmp[y * 8 + u]! * COS[v]![y]!;
            block[v * 8 + u] = s;
        }
        for (let i = 0; i < 64; i++) coef[i] = Math.round(block[ZIGZAG[i]!]! / table[ZIGZAG[i]!]!);
        const diff = coef[0]! - prevDc[comp]!;
        prevDc[comp] = coef[0]!;
        const dcSize = sizeOf(diff);
        const dc = DC_CODES.get(dcSize)!;
        bits.put(dc.code, dc.len);
        if (dcSize) bits.put(diff < 0 ? diff - 1 : diff, dcSize);
        let zeros = 0;
        for (let i = 1; i < 64; i++) {
            const v = coef[i]!;
            if (v === 0) {
                zeros++;
                continue;
            }
            while (zeros > 15) {
                const zrl = AC_CODES.get(0xf0)!;
                bits.put(zrl.code, zrl.len);
                zeros -= 16;
            }
            const s = sizeOf(v);
            const ac = AC_CODES.get((zeros << 4) | s)!;
            bits.put(ac.code, ac.len);
            bits.put(v < 0 ? v - 1 : v, s);
            zeros = 0;
        }
        if (zeros > 0) {
            const eob = AC_CODES.get(0x00)!;
            bits.put(eob.code, eob.len);
        }
    };

    for (let by = 0; by < img.height; by += 8) {
        for (let bx = 0; bx < img.width; bx += 8) {
            for (let y = 0; y < 8; y++) {
                const yy = Math.min(img.height - 1, by + y);
                for (let x = 0; x < 8; x++) {
                    const xx = Math.min(img.width - 1, bx + x);
                    const i = (yy * img.width + xx) * 3;
                    const r = img.rgb[i]!;
                    const g = img.rgb[i + 1]!;
                    const b = img.rgb[i + 2]!;
                    const k = y * 8 + x;
                    planes[0]![k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
                    planes[1]![k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
                    planes[2]![k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
                }
            }
            encodeBlock(planes[0]!, 0, qy);
            encodeBlock(planes[1]!, 1, qc);
            encodeBlock(planes[2]!, 2, qc);
        }
    }
    const data = bits.finish();
    const head = Buffer.from(out);
    return Buffer.concat([head, Buffer.from(data), Buffer.from([0xff, 0xd9])]);
}

// ── the whole job ───────────────────────────────────────────────────────────

export interface ScreenshotOptions {
    /** The coordinate space of the rectangles (the phone's screen size as the screen description reports it); when it differs from the picture's, they are scaled. */
    coverSpace?: { width: number; height: number };
    maxWidth?: number;
    /** Largest JPEG in bytes (the contract says 120 KB). */
    maxBytes?: number;
}

/**
 * The screenshot a snapshot carries: the PNG from the phone, the covered areas painted flat on the full-size pixels, scaled to at most 640 px wide and
 * written as a JPEG of at most 120 KB (quality steps down, then the width). undefined when the PNG cannot be read.
 */
export function screenshotJpeg(png: Buffer, covers: ReadonlyArray<readonly [number, number, number, number]>, opts: ScreenshotOptions = {}): { jpeg: Buffer; width: number; height: number } | undefined {
    const decoded = decodePng(png);
    if (!decoded) return undefined;
    const sx = opts.coverSpace && opts.coverSpace.width > 0 ? decoded.width / opts.coverSpace.width : 1;
    const sy = opts.coverSpace && opts.coverSpace.height > 0 ? decoded.height / opts.coverSpace.height : 1;
    coverRects(
        decoded,
        covers.map(([l, t, r, b]) => [l * sx, t * sy, r * sx, b * sy] as const),
    );
    const maxBytes = opts.maxBytes ?? 120_000;
    let width = opts.maxWidth ?? 640;
    for (let attempt = 0; attempt < 4; attempt++) {
        const img = scaleDown(decoded, width);
        for (const q of [62, 45, 30]) {
            const jpeg = encodeJpeg(img, q);
            if (jpeg.length <= maxBytes) return { jpeg, width: img.width, height: img.height };
        }
        width = Math.max(120, Math.floor(width * 0.75));
    }
    return undefined;
}
