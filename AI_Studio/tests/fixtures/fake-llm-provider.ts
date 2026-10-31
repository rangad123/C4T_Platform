/**
 * A local fake AI provider speaking three dialects over real HTTP, for the reliability tests (never a real provider):
 *   /openai/v1/chat/completions                       OpenAI Chat Completions (also OpenRouter and local OpenAI-compatible servers)
 *   /anthropic/v1/messages                            Anthropic Messages
 *   /google/v1beta/models/<model>:generateContent     Google Gemini
 * Each test queues the answers it wants (status, body, headers, a delay or no answer at all); an empty queue answers normally.
 * Every request is recorded (path, model and the request body) so a test can count calls and read the prompt that was sent.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Scripted {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    /** Answer text for a normal reply (dialect-shaped). */
    text?: string;
    /** OpenAI finish_reason / Anthropic stop_reason / Google finishReason for a normal reply. */
    finish?: string;
    delayMs?: number;
    /** Never answer (the client's time limit must end the request). */
    hang?: boolean;
}

export interface Seen {
    path: string;
    model: string;
    body: any;
}

export interface FakeProvider {
    url: string;
    port: number;
    /** Queue answers for requests whose model is `model` (or for any model with "*"). */
    queue(model: string, ...answers: Scripted[]): void;
    seen: Seen[];
    reset(): void;
    close(): Promise<void>;
}

function dialectOf(path: string): "openai" | "anthropic" | "google" | undefined {
    if (path.startsWith("/openai/")) return "openai";
    if (path.startsWith("/anthropic/")) return "anthropic";
    if (path.startsWith("/google/")) return "google";
    return undefined;
}

function okBody(dialect: "openai" | "anthropic" | "google", model: string, text: string, finish?: string): unknown {
    switch (dialect) {
        case "openai":
            return { id: "chatcmpl-1", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish ?? "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } };
        case "anthropic":
            return { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: finish ?? "end_turn", stop_sequence: null, usage: { input_tokens: 11, output_tokens: 4 } };
        case "google":
            return { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: finish ?? "STOP", index: 0 }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 } };
    }
}

export async function startFakeProvider(port: number): Promise<FakeProvider> {
    const queues = new Map<string, Scripted[]>();
    const seen: Seen[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const path = (req.url ?? "").split("?")[0]!;
            const dialect = dialectOf(path);
            let body: any = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch {
                body = {};
            }
            const model = dialect === "google" ? decodeURIComponent(/models\/([^:]+):/.exec(path)?.[1] ?? "") : String(body.model ?? "");
            seen.push({ path, model, body });
            const q = queues.get(model)?.length ? queues.get(model)! : (queues.get("*") ?? []);
            const step: Scripted = q.shift() ?? {};
            if (!dialect) {
                res.writeHead(404, { "content-type": "application/json" });
                return res.end(JSON.stringify({ error: { message: "Not found" } }));
            }
            if (step.hang) return; // the socket is closed by close() or by the client's own time limit
            const send = () => {
                const status = step.status ?? 200;
                const payload = step.body !== undefined ? step.body : okBody(dialect, model, step.text ?? "OK", step.finish);
                res.writeHead(status, { "content-type": "application/json", ...step.headers });
                res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
            };
            if (step.delayMs) setTimeout(send, step.delayMs);
            else send();
        });
    });
    server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
    const actual = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        seen,
        queue(model, ...answers) {
            const q = queues.get(model) ?? [];
            q.push(...answers);
            queues.set(model, q);
        },
        reset() {
            queues.clear();
            seen.length = 0;
        },
        close() {
            for (const s of sockets) s.destroy();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
