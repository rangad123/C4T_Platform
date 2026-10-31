/**
 * Notices for a live session that the platform says once, when the session opens.
 *
 * The address guard (net-guard.ts) refuses private and loopback targets only when BLOCK_PRIVATE_TARGETS=true, which is off by default so that local sample
 * apps work. A live session is more than a recording: a snapshot returns the page's text and field values to whoever drives it, so an open guard turns "open a
 * page" into "read a page on the platform's own network". The platform does not refuse (that would break the local sample apps the tests use); it says so.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateHost } from "./net-guard.js";

export const PRIVATE_TARGET_NOTICE =
    "This address is on a private or loopback network, and this platform does not block those (BLOCK_PRIVATE_TARGETS is off). A live session returns the page's text, so anyone who can drive it can read pages on this network. Turn BLOCK_PRIVATE_TARGETS on if the tools that open sessions are not fully trusted.";

/** The notices for a session about to open on `url` on the platform's own browser (empty when the guard is on or the address is public). */
export async function liveOpenWarnings(url: string): Promise<string[]> {
    if (process.env.BLOCK_PRIVATE_TARGETS === "true") return [];
    let host: string;
    try {
        host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    } catch {
        return [];
    }
    let addrs: string[] = [host];
    if (!net.isIP(host)) addrs = (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    return isPrivateHost(host) || addrs.some(isPrivateHost) ? [PRIVATE_TARGET_NOTICE] : [];
}
