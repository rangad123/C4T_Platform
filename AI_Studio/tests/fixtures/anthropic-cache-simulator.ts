/**
 * A fake Anthropic Messages endpoint that bills like Anthropic's prompt cache as documented, for the prompt-caching tests (never a real
 * provider). Moved here from tests/prompt-cache.test.ts so several test files can measure with it.
 */
import crypto from "node:crypto";
import http from "node:http";

/**
 * A fake Anthropic Messages endpoint that bills like Anthropic's prompt cache as documented: blocks in the order tools, system,
 * messages; a prefix is cached at each breakpoint (block cache_control, or the request-level marker on the last block) once it is at
 * least MIN tokens; a later request reads the longest cached prefix found at or up to 20 blocks before one of its breakpoints. Tokens
 * are characters / 4. The answers are scripted, so the same conversation runs with caching on and off.
 */
export async function startCacheSimulator(port: number, answer: (body: any, n: number) => unknown) {
    const MIN = 512;
    const cache = new Set<string>();
    const strip = (b: unknown) => JSON.stringify(b, (k, v) => (k === "cache_control" ? undefined : v));
    let n = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const blocks: any[] = [...(body.tools ?? []), ...(Array.isArray(body.system) ? body.system : body.system ? [{ type: "text", text: body.system }] : [])];
            for (const m of body.messages) for (const c of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) blocks.push({ role: m.role, ...c });
            const tokens = blocks.map((b) => Math.ceil(strip(b).length / 4));
            const cum: number[] = [];
            tokens.reduce((s, t, i) => (cum[i] = s + t), 0);
            const key = (i: number) => crypto.createHash("sha1").update(blocks.slice(0, i + 1).map(strip).join("\u0001")).digest("hex");
            const bps = blocks.map((b, i) => (b.cache_control ? i : -1)).filter((i) => i >= 0);
            if (body.cache_control) bps.push(blocks.length - 1);
            let read = 0;
            for (const bp of [...new Set(bps)].sort((a, b) => b - a)) {
                for (let j = bp; j >= Math.max(0, bp - 20) && !read; j--) if (cache.has(key(j))) read = cum[j]!;
                if (read) break;
            }
            let write = 0;
            for (const bp of bps) {
                if (cum[bp]! < MIN) continue;
                if (!cache.has(key(bp))) write = Math.max(write, cum[bp]! - read);
                cache.add(key(bp));
            }
            const total = cum[cum.length - 1] ?? 0;
            const out: any = answer(body, n++);
            out.usage = { input_tokens: total - read - write, output_tokens: 20, cache_read_input_tokens: read, cache_creation_input_tokens: write };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(out));
        });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    return { url: `http://127.0.0.1:${port}`, reset: () => ((n = 0), cache.clear()), close: () => new Promise<void>((r) => server.close(() => r())) };
}
