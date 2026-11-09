/** Local and private-network addresses are almost always plain HTTP; everything else defaults to HTTPS. */
function defaultScheme(hostPart: string): "http" | "https" {
    const host = hostPart.split(/[/?#]/)[0]!.replace(/:\d+$/, "").toLowerCase();
    return host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? "http" : "https";
}

/** Accept "example.com" as well as full URLs; only http(s) is testable. */
export function normalizeUrl(raw: string): { url?: string; error?: string } {
    const t = raw.trim();
    if (!t) return { error: "Enter the address of the application you want to test." };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${defaultScheme(t)}://${t}`;
    try {
        const u = new URL(withScheme);
        if (!/^https?:$/.test(u.protocol)) return { error: "Only web addresses starting with http:// or https:// can be tested." };
        if (!u.hostname.includes(".") && u.hostname !== "localhost" && !/^[\d.:[\]]+$/.test(u.hostname)) return { error: "That doesn’t look like a complete address. Try something like https://example.com." };
        return { url: u.toString() };
    } catch {
        return { error: "That doesn’t look like a valid address. Try something like https://example.com." };
    }
}

/**
 * An address from another system (an issue tracker, Sentry, a device farm) made safe for a link: only http(s) is kept. React 18
 * still follows a `javascript:` href, so an address such a system sent back is never used as it came.
 */
export function externalHref(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
    } catch {
        return undefined;
    }
}
