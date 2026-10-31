import type { FastifyInstance } from "fastify";
import { InfraError } from "./errors.js";

/** A non-2xx answer from the platform API. */
export class ApiCallError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

/**
 * The platform REST API as the command line sees it. Remote mode talks to a running server over HTTP;
 * local mode calls an in-process server, so both modes share every line of the run/collect logic.
 */
export interface ApiClient {
    json<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
    bytes(path: string): Promise<Buffer>;
}

function failure(status: number, text: string): ApiCallError {
    let msg = text.slice(0, 300) || `HTTP ${status}`;
    let details: unknown;
    try {
        const o = JSON.parse(text) as { error?: string; details?: unknown };
        if (o.error) msg = o.error;
        details = o.details;
    } catch {
        /* keep the raw text */
    }
    return new ApiCallError(status, msg, details);
}

export function remoteClient(server: string, apiKey?: string): ApiClient {
    const base = server.replace(/\/+$/, "");
    const headers = (json: boolean): Record<string, string> => ({ ...(json ? { "content-type": "application/json" } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}) });
    const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
        try {
            return await fetch(`${base}/api${path}`, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000) });
        } catch {
            throw new InfraError(`Could not reach the platform at ${base}. Check --server and that the platform is running.`);
        }
    };
    return {
        async json(method, path, body) {
            const res = await send(method, path, body);
            const text = await res.text();
            if (res.status === 401) throw new InfraError("The platform refused the API key. Pass the right one with --api-key-env.");
            if (!res.ok) throw failure(res.status, text);
            return (text ? JSON.parse(text) : undefined) as never;
        },
        async bytes(path) {
            const res = await send("GET", path);
            if (!res.ok) throw failure(res.status, await res.text());
            return Buffer.from(await res.arrayBuffer());
        },
    };
}

export function localClient(app: FastifyInstance): ApiClient {
    return {
        async json(method, path, body) {
            const res = await app.inject({ method, url: `/api${path}`, payload: body as never });
            if (res.statusCode >= 400) throw failure(res.statusCode, res.body);
            return (res.body ? JSON.parse(res.body) : undefined) as never;
        },
        async bytes(path) {
            const res = await app.inject({ method: "GET", url: `/api${path}` });
            if (res.statusCode >= 400) throw failure(res.statusCode, res.body);
            return res.rawPayload;
        },
    };
}
