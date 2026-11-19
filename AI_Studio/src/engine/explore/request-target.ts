/**
 * The target of a state-changing request, as the exploration's request bound counts it (CP3b R-2). Pure: no browser.
 *
 * A request that may change the application's data (POST, PUT, PATCH, DELETE) is named by its method and its address pattern: the
 * origin and path, with record ids replaced by `:id` (explore/state.ts) and any other run of digits by `#`, and without the query. So
 * `POST /orders/14?i=3` and `POST /orders/15` are one target, whatever the page calls the control that sends it. A GraphQL-style
 * JSON body's `operationName` is added, so one endpoint's operations count apart. Any other method changes nothing and is never a target.
 */
import { pathPattern } from "./state.js";

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** `METHOD origin/path-pattern[#operation]`, or undefined for a method that changes nothing or an address that does not parse. */
export function requestTarget(method: string, url: string, body?: string | null): string | undefined {
    const m = method.toUpperCase();
    if (!STATE_CHANGING_METHODS.has(m)) return undefined;
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return undefined;
    }
    const path = pathPattern(`${u.origin}${u.pathname}`).replace(/\d+/g, "#");
    let op = "";
    if (body && body.length <= 20_000 && body.trimStart().startsWith("{")) {
        try {
            const name = (JSON.parse(body) as { operationName?: unknown }).operationName;
            if (typeof name === "string" && /^\w{1,80}$/.test(name)) op = `#${name}`;
        } catch {
            /* not JSON: no operation */
        }
    }
    return `${m} ${u.origin}${path}${op}`;
}
