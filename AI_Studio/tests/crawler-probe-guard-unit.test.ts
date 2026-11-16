/**
 * The route handler that shuts the network while validation is probed: whatever Playwright throws at it (a navigation request whose
 * frame is gone, a route already handled or closed), the request is refused and the handler never rejects, so no failure can become an
 * unhandled rejection that ends the process. And it never lets a request through.
 */
import type { Page, Route } from "playwright";
import { describe, expect, it } from "vitest";
import { refuseAllFor } from "../src/engine/discovery/crawler.js";

const mainFrame = {};
const probePage = { mainFrame: () => mainFrame } as unknown as Page;

function fakeRoute(o: { navigation: boolean; frame: () => unknown; fulfill?: () => Promise<void>; abort?: () => Promise<void> }) {
    const done: string[] = [];
    const route = {
        request: () => ({ isNavigationRequest: () => o.navigation, frame: o.frame }),
        fulfill: (x: { status: number }) => (done.push(`fulfill ${x.status}`), o.fulfill ? o.fulfill() : Promise.resolve()),
        abort: () => (done.push("abort"), o.abort ? o.abort() : Promise.resolve()),
        continue: () => (done.push("continue"), Promise.resolve()),
        fallback: () => (done.push("fallback"), Promise.resolve()),
    } as unknown as Route;
    return { route, done };
}

describe("the probe's network shut", () => {
    it("refuses a navigation request whose frame is not available, without throwing or rejecting", async () => {
        const { route, done } = fakeRoute({
            navigation: true,
            frame: () => {
                throw new Error("Frame for this navigation request is not available");
            },
        });
        const handler = refuseAllFor(probePage);
        let result: unknown;
        expect(() => (result = handler(route))).not.toThrow();
        await expect(Promise.resolve(result)).resolves.toBeUndefined();
        expect(done).toEqual(["abort"]);
    });

    it("does not reject when the route was already handled or its page closed", async () => {
        const closed = () => Promise.reject(new Error("Route is already handled!"));
        const nav = fakeRoute({ navigation: true, frame: () => mainFrame, fulfill: closed, abort: closed });
        await expect(Promise.resolve(refuseAllFor(probePage)(nav.route))).resolves.toBeUndefined();
        const other = fakeRoute({ navigation: false, frame: () => mainFrame, abort: closed });
        await expect(Promise.resolve(refuseAllFor(probePage)(other.route))).resolves.toBeUndefined();
        // Nothing was let through either way.
        expect([...nav.done, ...other.done].filter((d) => d === "continue" || d === "fallback")).toEqual([]);
    });

    it("answers the probe page's own document load with 204 and refuses everything else", async () => {
        const own = fakeRoute({ navigation: true, frame: () => mainFrame });
        const child = fakeRoute({ navigation: true, frame: () => ({}) });
        const fetchCall = fakeRoute({ navigation: false, frame: () => mainFrame });
        for (const r of [own, child, fetchCall]) await refuseAllFor(probePage)(r.route);
        expect([own.done, child.done, fetchCall.done]).toEqual([["fulfill 204"], ["abort"], ["abort"]]);
    });
});
