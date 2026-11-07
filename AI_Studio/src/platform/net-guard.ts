import dns from "node:dns/promises";
import net from "node:net";
import { HttpError } from "./http-error.js";

/** Shared outbound-URL guard: used for tested applications, spec URLs, webhooks and issue-tracker URLs. */
export function isPrivateHost(host: string): boolean {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
    if (net.isIPv4(host)) {
        const [a, b] = host.split(".").map(Number) as [number, number];
        return (
            a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) // CGNAT
        );
    }
    if (net.isIPv6(host)) {
        const h = host.toLowerCase();
        // IPv4-mapped addresses: the URL parser normalises ::ffff:127.0.0.1 to ::ffff:7f00:1.
        const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
        if (hex) {
            const [x, y] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
            return isPrivateHost(`${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`);
        }
        const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
        if (dotted) return isPrivateHost(dotted[1]!);
        // fc00::/7 unique local, fe80::/10 link-local and the old fec0::/10 site-local (fe8x-fefx), ff00::/8 multicast.
        return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || /^fe[89a-f]/.test(h) || h.startsWith("ff");
    }
    return false;
}

/** SSRF guard: only http(s); optionally refuse loopback/private targets (BLOCK_PRIVATE_TARGETS=true). */
export async function assertAllowedTarget(raw: string): Promise<void> {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only http(s) URLs can be tested");
    if (process.env.BLOCK_PRIVATE_TARGETS !== "true") return;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let addrs = [host];
    if (!net.isIP(host)) addrs = (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (isPrivateHost(host) || addrs.some(isPrivateHost)) throw new HttpError(400, "Target resolves to a private/loopback address (BLOCK_PRIVATE_TARGETS is enabled)");
}
