/**
 * The target of a state-changing request, as the exploration's request bound counts it (CP3b R-2). Pure: no browser.
 *
 * A request that may change the application's data (POST, PUT, PATCH, DELETE) is named by its method and its address pattern: the
 * origin and path, with record ids replaced by `:id` (explore/state.ts) and any other run of digits by `#`, and without the query. So
 * `POST /orders/14?i=3` and `POST /orders/15` are one target, whatever the page calls the control that sends it. A GraphQL-style
 * JSON body's `operationName` is added, so one endpoint's operations count apart. Any other method changes nothing and is never a target.
 */
import { createHash } from "node:crypto";
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

/** A currency symbol or code beside an amount. */
const CURRENCY = String.raw`(?:[$€£¥₹₩₽¢]|\b(?:usd|eur|gbp|inr|jpy|cny|cad|aud|chf|rs)\b\.?)`;
/** A number or amount: digits with "." or "," between them, an optional currency symbol or code on either side. */
const AMOUNT = new RegExp(String.raw`(?:${CURRENCY}\s*)?\d(?:[\d.,]*\d)?(?:\s*${CURRENCY})?`, "gu");
/** Amounts joined by an arrow or a dash ("$12.50 → $25.00", "1-3"): one placeholder. */
const AMOUNT_RUN = /#(?:\s*(?:→|⟶|➔|➜|⇒|=>|->|-|–|—|»|›)\s*#)+/gu;

/**
 * A control's role and accessible name as the request bound's sender knows it (CP3c T-1, CP3d U-3): case and spacing folded, a count
 * badge ("Order (3)", "Cart [2]") and pictographs dropped, and every other number or currency amount, with the arrows between
 * amounts, replaced by "#": "Buy now — 3 in cart", "9 left - Buy" and "Pay $12.50 → $25.00" keep one name whatever their counters
 * and prices say. Controls whose names differ only by a number ("Tab 1", "Tab 2", a pager's "1", "2") are told apart by their place
 * (`elementSender`), not by the number.
 */
export function senderName(roleAndName: string): string {
    return roleAndName
        .toLowerCase()
        .replace(/[([]\s*\d+\s*[)\]]/g, "")
        .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
        .replace(AMOUNT, "#")
        .replace(AMOUNT_RUN, "#")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * The request bound's sender of an element (CP3d U-3), as a 12-digit digest: its anchor (web/author.ts: its form and landmark
 * ancestry, tag and type), its role and name as `senderName` folds them, and its place among its parent's children of the same tag
 * and role (`position`). The place keeps controls whose names differ only by a number apart ("Tab 1" and "Tab 2", pager links), and
 * a control the page re-renders in its place (a new element) is the same sender whatever count or price its name now carries.
 */
export function elementSender(anchor: string, roleAndName: string, position: number): string {
    return createHash("sha256").update(`${anchor}\n${senderName(roleAndName)}\n${position}`).digest("hex").slice(0, 12);
}
