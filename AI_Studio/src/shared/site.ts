// Same-site, by the public suffix list (tldts), including its private part: hosting domains where each customer gets a sub-domain
// (vercel.app, github.io, herokuapp.com, s3.amazonaws.com) count as suffixes, so a.vercel.app and b.vercel.app are different sites,
// while api.shop.example.co.uk and www.shop.example.co.uk are the same one. Engine and platform code both use this one helper.
import { getDomain } from "tldts";

/** A host name without brackets, port or trailing dot, in lower case (`[::1]:8080` -> `::1`, `Shop.Example.com.:443` -> `shop.example.com`). */
function bareHost(host: string): string {
    let h = host.trim().toLowerCase();
    const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(h);
    if (bracketed) return bracketed[1]!;
    if (!h.includes(":") || /^[^:]*:\d*$/.test(h)) h = h.replace(/:\d*$/, "");
    return h.replace(/\.$/, "");
}

const isIp = (h: string): boolean => /^\d+(?:\.\d+){3}$/.test(h) || h.includes(":");

/**
 * The site of a host (its registrable domain under the public suffix list, private suffixes included). Undefined for an IP address,
 * a one-label name (localhost) and a host that is itself a public suffix (vercel.app, co.uk): those match only by their exact name.
 */
export function siteOf(host: string): string | undefined {
    const h = bareHost(host);
    if (!h || isIp(h) || !h.includes(".")) return undefined;
    return getDomain(h, { allowPrivateDomains: true }) ?? undefined;
}

/** Whether two hosts (ports ignored) are the same host, or hosts of the same site. */
export function sameSite(a: string, b: string): boolean {
    const x = bareHost(a);
    const y = bareHost(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const site = siteOf(x);
    return site !== undefined && site === siteOf(y);
}
