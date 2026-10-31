/**
 * Is the person looking at the platform from a different computer than the one that runs it? True when the page was opened through an
 * address that is not this computer's own (a shared link, a LAN address, a server name). A browser window the platform opens for
 * recording then appears on the platform's computer, where this person cannot click in it.
 * `?remote=1` in the page address forces the answer (used by tests and for trying the warning out).
 */
export function isLoopbackHost(hostname: string): boolean {
    const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function viewerIsRemote(hostname: string = typeof location === "undefined" ? "localhost" : location.hostname, hash: string = typeof location === "undefined" ? "" : location.hash): boolean {
    const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    if (new URLSearchParams(query).get("remote") === "1") return true;
    return !isLoopbackHost(hostname);
}
