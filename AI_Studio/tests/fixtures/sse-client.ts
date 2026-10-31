/**
 * A small server-sent-events client for tests: plain node:http, records every frame with its arrival time, can be paused (a slow
 * reader), aborted (a browser tab closed) and asked to wait for a frame. It is not the browser's EventSource on purpose: it
 * lets the tests set headers (Last-Event-ID) and see exactly what the server wrote.
 */
import http from "node:http";

export interface SseFrame {
    event: string;
    id?: string;
    data: any;
    /** The frame as written, without the final blank line. */
    raw: string;
    /** When it arrived (Date.now()). */
    at: number;
}

/** Every address any test client has requested (the tests assert the API key is never in one). */
export const requestedUrls: string[] = [];

export class SseClient {
    frames: SseFrame[] = [];
    comments: string[] = [];
    status = 0;
    headers: http.IncomingHttpHeaders = {};
    /** The whole body when the answer was not a stream (an error). */
    body = "";
    /** True once the server ended the response or the connection dropped. */
    closed = false;
    text = "";
    private buf = "";
    private req!: http.ClientRequest;
    private res?: http.IncomingMessage;
    private waiters: Array<() => void> = [];

    static open(port: number, path: string, headers: Record<string, string> = {}): Promise<SseClient> {
        const c = new SseClient();
        requestedUrls.push(path);
        return new Promise((resolve, reject) => {
            c.req = http.get({ host: "127.0.0.1", port, path, headers: { accept: "text/event-stream", ...headers } }, (res) => {
                c.res = res;
                c.status = res.statusCode ?? 0;
                c.headers = res.headers;
                res.setEncoding("utf8");
                res.on("data", (d: string) => c.feed(d));
                res.on("end", () => c.finish());
                res.on("close", () => c.finish());
                res.on("error", () => c.finish());
                resolve(c);
            });
            c.req.on("error", (e) => {
                if (!c.status) reject(e);
                else c.finish();
            });
        });
    }

    private feed(chunk: string): void {
        this.text += chunk;
        if (this.status !== 200 || !String(this.headers["content-type"]).startsWith("text/event-stream")) {
            this.body += chunk;
            return;
        }
        this.buf += chunk;
        let at: number;
        while ((at = this.buf.indexOf("\n\n")) >= 0) {
            const raw = this.buf.slice(0, at);
            this.buf = this.buf.slice(at + 2);
            this.frame(raw);
        }
        this.wake();
    }

    private frame(raw: string): void {
        let event = "message";
        let id: string | undefined;
        const data: string[] = [];
        const comments: string[] = [];
        for (const line of raw.split("\n")) {
            if (line.startsWith(":")) comments.push(line.slice(1).trim());
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        this.comments.push(...comments);
        if (data.length === 0 && !id && event === "message") return;
        let parsed: any = data.join("\n");
        try {
            parsed = JSON.parse(parsed);
        } catch {
            /* keep the text */
        }
        this.frames.push({ event, ...(id !== undefined ? { id } : {}), data: parsed, raw, at: Date.now() });
    }

    private finish(): void {
        this.closed = true;
        this.wake();
    }

    private wake(): void {
        for (const w of this.waiters.splice(0)) w();
    }

    /** Resolves when `pred` holds (checked after every chunk); rejects after `ms` with what had arrived. */
    async waitFor(pred: (c: SseClient) => boolean, ms = 15_000, what = "the expected frames"): Promise<void> {
        const end = Date.now() + ms;
        while (!pred(this)) {
            if (this.closed && !pred(this)) throw new Error(`the stream closed before ${what}; got ${this.frames.map((f) => f.event + (f.id ? `#${f.id}` : "")).join(",")}`);
            if (Date.now() > end) throw new Error(`timed out waiting for ${what}; got ${this.frames.map((f) => f.event + (f.id ? `#${f.id}` : "")).join(",")}`);
            await new Promise<void>((r) => {
                this.waiters.push(r);
                setTimeout(r, 100);
            });
        }
    }

    untilClosed(ms = 15_000): Promise<void> {
        return this.waitFor((c) => c.closed, ms, "the server to close the stream").catch((e) => {
            if (!this.closed) throw e;
        });
    }

    logs(): Array<{ id: number; at: string; level: string; message: string; stage: string; kind: string; jobId: string }> {
        return this.frames.filter((f) => f.event === "log").map((f) => f.data);
    }
    logIds(): number[] {
        return this.logs().map((l) => l.id);
    }
    last(event: string): SseFrame | undefined {
        return [...this.frames].reverse().find((f) => f.event === event);
    }

    /** Stop reading (the kernel and the server buffer what is sent). */
    pause(): void {
        this.res?.pause();
    }
    resume(): void {
        this.res?.resume();
    }
    /** Close the connection like a closed browser tab. */
    abort(): void {
        this.req.destroy();
        this.res?.destroy();
        this.finish();
    }
}
