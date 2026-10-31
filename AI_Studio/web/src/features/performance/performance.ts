/** Plain-language formatting of page-speed measurements. */

export interface Measured {
    metric: string;
    value: number;
    unit: string;
    budget?: number;
}

export interface SpeedHistory {
    latest: Array<Measured & { at: string }>;
    history: Array<{ at: string; executionId: string; values: Record<string, number> }>;
}

export const METRIC_LABEL: Record<string, string> = {
    ttfb: "Server starts responding",
    fcp: "First content appears",
    lcp: "Main content appears",
    cls: "Layout stability",
    load: "Page finished loading",
    weight: "Page size",
    requests: "Requests made",
    p50: "Typical response time",
    p95: "95% of responses within",
    max: "Slowest response",
    // Load check (see engine/performance/load.ts)
    load_users: "Users at once",
    load_requests: "Requests sent",
    load_rps: "Requests per second",
    load_error_rate: "Requests that failed",
    load_p50: "Typical response time",
    load_p95: "95% of responses within",
    load_max: "Slowest response",
    load_ok: "Answered successfully",
    load_4xx: "Answered with a client error (4xx)",
    load_5xx: "Answered with a server error (5xx)",
    load_429: "Turned away (HTTP 429, rate limit)",
    load_network: "No answer (network failure)",
};

/**
 * What each measurement means, written from how it is measured: src/engine/performance/checks.ts (page speed: median of 3 fresh
 * loads), latency.ts (one request at a time after a warm-up) and load.ts (several users at once). Shown as a "?" next to the name.
 */
export const METRIC_HELP: Record<string, string> = {
    ttfb: "Time from asking for the page until the server’s answer starts to arrive.",
    fcp: "Time until the browser first shows any text or image.",
    lcp: "Time until the largest text block or image in view is shown.",
    cls: "How much the content jumps around while loading, not counting moves a visitor causes. 0 is perfectly still; under 0.1 is good.",
    load: "Time until the browser finished loading the page and its files.",
    weight: "Everything the page downloaded, counted as sent over the network.",
    requests: "Files the page fetched, the page itself included.",
    p50: "Half of the measured responses were faster than this.",
    p95: "95 of every 100 measured responses were faster than this.",
    max: "The slowest of the measured responses.",
    load_users: "Simulated users sending requests at the same time. Each waits for its answer before the next request.",
    load_requests: "Requests sent during the check, at most 300.",
    load_rps: "Requests finished per second, answered or not, over the whole check.",
    load_error_rate: "Requests that got a server error (500 or higher) or no answer at all. 4xx answers and 429 are not counted here.",
    load_p50: "Half of the answered requests were faster than this.",
    load_p95: "95 of every 100 answered requests were faster than this.",
    load_max: "The slowest answered request.",
    load_ok: "Requests answered with a success status (below 400).",
    load_4xx: "Requests answered with 400 to 499, except 429: usually the request itself was refused.",
    load_5xx: "Requests the server answered with an error of its own (500 or higher).",
    load_429: "The server asked to slow down. The check stops at the first one to protect the application.",
    load_network: "Requests that got no answer: the connection was refused, dropped or timed out.",
};

/** Order shown to people: what a visitor feels first, then the totals. */
export const METRIC_ORDER = ["ttfb", "fcp", "lcp", "cls", "load", "weight", "requests", "p50", "p95", "max", "load_users", "load_requests", "load_rps", "load_error_rate", "load_p50", "load_p95", "load_max", "load_ok", "load_4xx", "load_5xx", "load_429", "load_network"];

export function formatValue(m: { metric: string; value: number; unit: string }): string {
    if (m.unit === "ms") return m.value >= 1000 ? `${(m.value / 1000).toFixed(1)} s` : `${Math.round(m.value)} ms`;
    if (m.unit === "bytes") return m.value >= 1_048_576 ? `${(m.value / 1_048_576).toFixed(1)} MB` : `${Math.round(m.value / 1024)} KB`;
    if (m.unit === "score") return String(Math.round(m.value * 1000) / 1000);
    if (m.unit === "%") return m.value.toFixed(1) + "%";
    if (m.unit === "req/s") return m.value.toFixed(1) + " per second";
    return String(Math.round(m.value));
}

export type Verdict = "good" | "over" | "none";

/** Within its budget, over it, or nothing to compare with. Words are always shown with the colour. */
export function verdictOf(m: Measured): Verdict {
    if (m.budget === undefined) return "none";
    return m.value <= m.budget ? "good" : "over";
}

export const VERDICT_TEXT: Record<Verdict, string> = { good: "Within budget", over: "Over budget", none: "" };

/** SVG polyline points for a tiny history line (oldest → newest), or "" with fewer than 2 points. */
export function sparkPoints(values: number[], width = 120, height = 28): string {
    if (values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values.map((v, i) => `${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`).join(" ");
}
