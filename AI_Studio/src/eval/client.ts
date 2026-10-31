/**
 * How the harness talks to the platform: always through the platform's public HTTP API, either a running platform (URL + API key) or a
 * platform the harness started in this process (Fastify `inject`, the same routes without a network port). Nothing reads the database.
 */
import type { FastifyInstance } from "fastify";

export interface Answer {
    status: number;
    body: any;
}

export interface PlatformClient {
    readonly mode: "in-process" | "remote";
    call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<Answer>;
    /** An .apk upload (raw bytes). */
    upload(url: string, data: Buffer): Promise<Answer>;
}

/** A refusal or error of the platform, with its own plain message. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const parse = (text: string): unknown => {
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

/** The answer's body, or an ApiError with the platform's message ("Project not found") when the status is not 2xx. */
export function ok(a: Answer, what: string): any {
    if (a.status >= 200 && a.status < 300) return a.body;
    const msg = a.body && typeof a.body === "object" && typeof a.body.error === "string" ? a.body.error : `HTTP ${a.status}`;
    throw new ApiError(a.status, `${what}: ${msg}`);
}

export function remoteClient(baseUrl: string, apiKey?: string): PlatformClient {
    const base = baseUrl.replace(/\/+$/, "");
    const headers = (extra: Record<string, string>) => ({ ...(apiKey ? { "x-api-key": apiKey } : {}), ...extra });
    const send = async (method: string, url: string, body: BodyInit | undefined, type?: string): Promise<Answer> => {
        const res = await fetch(`${base}${url}`, { method, headers: headers(type ? { "content-type": type } : {}), body });
        return { status: res.status, body: parse(await res.text()) };
    };
    return {
        mode: "remote",
        call: (method, url, body) => send(method, url, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : "application/json"),
        upload: (url, data) => send("POST", url, new Uint8Array(data), "application/vnd.android.package-archive"),
    };
}

/** `apiKey`: the platform's own key when its configuration has one (the routes check it in this process too). */
export function inProcessClient(server: FastifyInstance, apiKey?: string): PlatformClient {
    const send = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload: unknown, type?: string): Promise<Answer> => {
        const res = await server.inject({ method, url, payload: payload as never, headers: { ...(type ? { "content-type": type } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}) } });
        return { status: res.statusCode, body: parse(res.body) };
    };
    return {
        mode: "in-process",
        call: (method, url, body) => send(method, url, body, body === undefined ? undefined : "application/json"),
        upload: (url, data) => send("POST", url, data, "application/vnd.android.package-archive"),
    };
}
