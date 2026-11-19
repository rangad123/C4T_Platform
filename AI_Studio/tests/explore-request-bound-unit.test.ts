/**
 * The request bound of the exploration's action tracker (CP3b R-2), without a browser: state-changing requests are counted per pursuit
 * by method and address pattern, and an action that would send one again past the repeat limit is refused before it runs.
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-request-bound-unit.test.ts
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { requestTarget } from "../src/engine/explore/request-target.js";
import { actionTracker, REQUEST_REPEAT_LIMIT } from "../src/engine/orchestrator.js";

const START = "http://shop.test/order";
const ORDER = "POST http://shop.test/order";
const click = (name: string, anchor = "a1", form: string | null = ORDER) => ({ tool: "click", args: { target: { by: "css", value: name } }, target: `button "${name}" @${anchor}`, url: START, anchor: { anchor, ...(form ? { form } : {}) } });

/** Asks, then (allowed) runs the action: it sends `sends` and is told after. Returns the refusal, if any. */
function act(t: ReturnType<typeof actionTracker>, a: Parameters<ReturnType<typeof actionTracker>["before"]>[0], sends: string[] = []): string | undefined {
    const v = t.before(a);
    if (v.refusal) return v.refusal;
    for (const s of sends) t.request(s);
    t.after({ tool: a.tool, args: a.args, ok: true, url: START, read: a.read === true });
    return undefined;
}

describe("request targets", () => {
    it("are method and address pattern: ids and other digits become placeholders, the query is dropped", () => {
        expect(requestTarget("post", "http://shop.test/orders/14?i=3")).toBe(requestTarget("POST", "http://shop.test/orders/15"));
        expect(requestTarget("POST", "http://shop.test/orders/14")).toBe("POST http://shop.test/orders/:id");
        expect(requestTarget("POST", "http://shop.test/order-12/items")).toBe(requestTarget("POST", "http://shop.test/order-13/items"));
        expect(requestTarget("DELETE", "http://shop.test/cart/9f86d081884c7d65")).toBe("DELETE http://shop.test/cart/:id");
        expect(requestTarget("POST", "http://shop.test/a")).not.toBe(requestTarget("PUT", "http://shop.test/a"));
        expect(requestTarget("POST", "http://a.test/x")).not.toBe(requestTarget("POST", "http://b.test/x"));
    });
    it("only methods that change data have one", () => {
        for (const m of ["GET", "HEAD", "OPTIONS"]) expect(requestTarget(m, "http://shop.test/order")).toBeUndefined();
        for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(requestTarget(m, "http://shop.test/order")).toBeDefined();
    });
    it("a GraphQL-style body's operation name keeps one endpoint's operations apart", () => {
        const g = (op: string) => requestTarget("POST", "http://shop.test/graphql", JSON.stringify({ operationName: op, query: "…" }));
        expect(g("PlaceOrder")).toBe("POST http://shop.test/graphql#PlaceOrder");
        expect(g("PlaceOrder")).not.toBe(g("ViewCart"));
        expect(requestTarget("POST", "http://shop.test/graphql", "not json")).toBe("POST http://shop.test/graphql");
    });
});

describe("the request bound", () => {
    it("the limit is the loop's repeat limit: an action and its double submit", () => {
        expect(REQUEST_REPEAT_LIMIT).toBe(2);
    });

    it("a button whose name the page changes after each click: the third click is refused (its anchor sent the request twice)", () => {
        const t = actionTracker(START);
        expect(act(t, click("Order (0)"), [ORDER])).toBeUndefined();
        expect(act(t, click("Order (1)"), [ORDER])).toBeUndefined();
        expect(act(t, click("Order (2)"))).toMatch(/^The request POST http:\/\/shop\.test\/order was already sent 2 times in this pursuit/);
    });

    it("below the limit nothing is refused: the same form submitted twice with other values", () => {
        const t = actionTracker(START);
        const fill = (v: string) => ({ tool: "fill", args: { target: { by: "label", value: "Quantity" }, value: v }, target: `textbox "Quantity" @q1`, url: START, anchor: { anchor: "q1", form: ORDER } });
        expect(act(t, fill("1"))).toBeUndefined();
        expect(act(t, click("Order"), [ORDER])).toBeUndefined();
        expect(act(t, fill("2"))).toBeUndefined();
        expect(act(t, click("Order"), [ORDER])).toBeUndefined();
        // At the limit a field of the form may still be filled (it sends nothing); a click on the form is refused.
        expect(act(t, fill("3"))).toBeUndefined();
        expect(act(t, click("Order"))).toMatch(/already sent 2 times/);
    });

    it("reads, clock steps, navigations and fresh passes in between do not reset the count: it is the pursuit's", () => {
        const t = actionTracker(START);
        act(t, click("Order"), [ORDER]);
        act(t, { tool: "wait", args: { ms: 5 }, url: START, read: true });
        act(t, { tool: "clock", args: { op: "fastForward", minutes: 3 }, url: START });
        act(t, { tool: "navigate", args: { url: "/order?i=1" }, url: START });
        t.freshPass(START);
        act(t, click("Order"), [ORDER]);
        act(t, { tool: "navigate", args: { url: "/order?i=2" }, url: START });
        expect(act(t, click("Order"))).toMatch(/already sent 2 times/);
    });

    it("a click on the form that sends the request is refused even when its element was never seen (a late button, another spelling)", () => {
        const t = actionTracker(START);
        // The first two clicks were made before the button could be found: only the locator text named them.
        act(t, { tool: "click", args: { target: { by: "css", value: "form button" } }, url: START }, [ORDER]);
        act(t, { tool: "click", args: { target: { by: "css", value: "main button" } }, url: START }, [ORDER]);
        expect(act(t, click("Order", "zz9"))).toMatch(/on the form that sends it/);
    });

    it("a read is never refused by the bound", () => {
        const t = actionTracker(START);
        act(t, click("Order"), [ORDER]);
        act(t, click("Order"), [ORDER]);
        expect(t.before({ tool: "assert", args: { check: "visible" }, target: 'button "Order" @a1', url: START, read: true, anchor: { anchor: "a1", form: ORDER } }).refusal).toBeUndefined();
    });

    it("an action that never sent the request is not refused by it", () => {
        const t = actionTracker(START);
        act(t, click("Order"), [ORDER]);
        act(t, click("Order"), [ORDER]);
        expect(act(t, { ...click("Help", "h1", null), target: 'link "Help" @h1' })).toBeUndefined();
        expect(act(t, { tool: "navigate", args: { url: "/help" }, url: START })).toBeUndefined();
    });

    it("a request every action sends (an analytics call) refuses each sender only once it has sent it the limit's times itself", () => {
        const t = actionTracker(START);
        const EVENTS = "POST http://shop.test/events";
        const other = (n: string) => ({ ...click(n, n, null), target: `link "${n}" @${n}` });
        expect(act(t, other("A"), [EVENTS])).toBeUndefined();
        expect(act(t, other("B"), [EVENTS])).toBeUndefined();
        expect(act(t, other("C"), [EVENTS])).toBeUndefined();
        // Sent by three different actions: the page's own traffic on every action. A sent it once: allowed again.
        expect(act(t, other("A"), [EVENTS])).toBeUndefined();
        expect(act(t, other("A"))).toMatch(/^The request POST http:\/\/shop\.test\/events was already sent 4 times/);
    });

    it("a navigation that sends the request is known by its address pattern, whatever its query", () => {
        const t = actionTracker(START);
        const INIT = "POST http://shop.test/session";
        act(t, { tool: "navigate", args: { url: "/start?a=1" }, url: START }, [INIT]);
        act(t, { tool: "navigate", args: { url: "/start?a=2" }, url: START }, [INIT]);
        expect(act(t, { tool: "navigate", args: { url: "/start?a=3" }, url: START })).toMatch(/already sent 2 times/);
    });
});

describe("the state after a submit", () => {
    it("an action that sent a request is on a new state the second time (another value), and the third time is a repeat", () => {
        const t = actionTracker(START);
        const fill = (v: string) => ({ tool: "fill", args: { target: { by: "label", value: "Quantity" }, value: v }, target: `textbox "Quantity" @q1`, url: START, anchor: { anchor: "q1", form: ORDER } });
        const states: string[] = [];
        for (const v of ["1", "2", "3"]) {
            t.before(fill(v));
            t.after({ tool: "fill", args: {}, ok: true, url: START });
            const s = t.before(click("Order")).state;
            states.push(s);
            t.request(ORDER);
            t.after({ tool: "click", args: {}, ok: true, url: START });
        }
        expect(states[1]).not.toBe(states[0]);
        expect(states[2]).toBe(states[1]);
    });
    it("an action that sends nothing keeps the state it had before: the page pattern and the previous action alone", () => {
        const t = actionTracker(START);
        t.before(click("Tab", "t1", null));
        t.after({ tool: "click", args: {}, ok: true, url: START });
        const previous = createHash("sha256").update('click button "Tab" @t1').digest("hex").slice(0, 12);
        expect(t.before(click("Tab", "t1", null)).state).toBe(`/order|${previous}`);
    });
});

describe("the run's own sign-in", () => {
    const LOGIN = "POST http://shop.test/session";
    /** The sign-in form's own identity (its place on its page), as resolveTarget gives it for the password field and the submit alike. */
    const SIGN_IN_FORM = "f-login";
    const signInClick = { ...click("Sign in", "s1", LOGIN), url: "http://shop.test/login", anchor: { anchor: "s1", form: LOGIN, formId: SIGN_IN_FORM } };
    const pass = (t: ReturnType<typeof actionTracker>, fillAt: string) => {
        t.freshPass("http://shop.test/login");
        t.signedIn({ form: LOGIN, formId: SIGN_IN_FORM, url: fillAt });
        return act(t, signInClick, [LOGIN]);
    };
    it("its form, filled with the run's password on the engine's sign-in page, may be submitted by every pass", () => {
        const t = actionTracker("http://shop.test/login", [], { signInPath: "/login" });
        for (let i = 0; i < 5; i++) expect(pass(t, "http://shop.test/login?next=/order")).toBeUndefined();
        // Nothing else is exempt: an order submit is still refused the third time.
        act(t, click("Order"), [ORDER]);
        act(t, click("Order"), [ORDER]);
        expect(act(t, click("Order"))).toMatch(/already sent 2 times/);
    });
    it("the exemption is the sign-in form itself, not its address: another form posting to the same target is counted (CP3c T-4)", () => {
        // A single-endpoint app: the sign-in form and a Delete form elsewhere both post to /app.
        const APP = "POST http://shop.test/app";
        const t = actionTracker("http://shop.test/login", [], { signInPath: "/login" });
        const signInOnApp = { ...signInClick, anchor: { anchor: "s1", form: APP, formId: SIGN_IN_FORM } };
        t.signedIn({ form: APP, formId: SIGN_IN_FORM, url: "http://shop.test/login" });
        expect(act(t, signInOnApp, [APP])).toBeUndefined();
        const del = { ...click("Delete", "d1", APP), url: "http://shop.test/shop", anchor: { anchor: "d1", form: APP, formId: "f-delete" } };
        expect(act(t, del, [APP])).toBeUndefined();
        expect(act(t, del, [APP])).toBeUndefined();
        expect(act(t, del, [APP])).toMatch(/^The request POST http:\/\/shop\.test\/app was already sent 2 times/);
        // The sign-in itself is still exempt on every pass.
        for (let i = 0; i < 3; i++) expect(pass(t, "http://shop.test/login")).toBeUndefined();
    });
    it("a fill that does not say which form it is in exempts nothing", () => {
        const t = actionTracker("http://shop.test/login", [], { signInPath: "/login" });
        const outs = [0, 1, 2].map(() => {
            t.freshPass("http://shop.test/login");
            t.signedIn({ form: LOGIN, url: "http://shop.test/login" });
            return act(t, signInClick, [LOGIN]);
        });
        expect(outs[2]).toMatch(/already sent 2 times/);
    });
    it("a page cannot claim it: a password filled on another page, or no sign-in page known to the engine, exempts nothing", () => {
        const elsewhere = actionTracker("http://shop.test/login", [], { signInPath: "/login" });
        expect(pass(elsewhere, "http://shop.test/order")).toBeUndefined();
        expect(pass(elsewhere, "http://shop.test/order")).toBeUndefined();
        expect(pass(elsewhere, "http://shop.test/order")).toMatch(/already sent 2 times/);
        const unknown = actionTracker("http://shop.test/login");
        pass(unknown, "http://shop.test/login");
        pass(unknown, "http://shop.test/login");
        expect(pass(unknown, "http://shop.test/login")).toMatch(/already sent 2 times/);
    });
});
