/**
 * Settings of the MCP server. Environment only (an AI tool starts the server from a JSON config, so there are no flags):
 *   AITP_URL      where the platform runs (default http://127.0.0.1:4000)
 *   AITP_API_KEY  the platform's API key, sent as `x-api-key` (only when the platform has one)
 * The key is held here and in the client only; nothing in this program prints it.
 */
export interface McpConfig {
    /** Platform address without a trailing slash. */
    baseUrl: string;
    /** host[:port] of the platform, for messages (never the key, never a path). */
    host: string;
    apiKey?: string;
    /** How often wait_for_job asks the platform (milliseconds). */
    pollMs: number;
}

export class ConfigError extends Error {}

export const DEFAULT_URL = "http://127.0.0.1:4000";

export function readConfig(env: Record<string, string | undefined> = process.env): McpConfig {
    const raw = (env.AITP_URL ?? "").trim() || DEFAULT_URL;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(`AITP_URL is not a web address: "${raw.slice(0, 80)}". Use something like ${DEFAULT_URL}.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("AITP_URL must start with http:// or https://.");
    const apiKey = (env.AITP_API_KEY ?? "").trim() || undefined;
    // Tests shorten the polling interval; people never need to set this.
    const poll = Number(env.AITP_POLL_MS);
    const pollMs = Number.isFinite(poll) && poll >= 50 && poll <= 10_000 ? Math.floor(poll) : 2000;
    return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, host: url.host, apiKey, pollMs };
}
