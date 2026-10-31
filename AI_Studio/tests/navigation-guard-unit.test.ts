import { describe, expect, it } from "vitest";
import { shouldBlockNavigation, type NavigationRequestLike } from "../src/engine/discovery/browser.js";

const allowed = new Set(["app.test:3000"]);
const mainFrame = { page: () => ({ mainFrame: () => mainFrame }) };
const subFrame = { page: () => ({ mainFrame: () => mainFrame }) };
const make = (url: string, over: Partial<NavigationRequestLike> = {}): NavigationRequestLike => ({
    isNavigationRequest: () => true,
    url: () => url,
    frame: () => mainFrame,
    ...over,
});
const notAvailable = () => {
    throw new Error("Frame for this navigation request is not available, because the request was issued before the frame is created.");
};

describe("navigation allow-list (discovery browser)", () => {
    it("lets allowed hosts, other request kinds and sub-frame navigations through", () => {
        expect(shouldBlockNavigation(make("http://app.test:3000/"), allowed)).toBe(false);
        expect(shouldBlockNavigation(make("https://elsewhere.test/x.js", { isNavigationRequest: () => false }), allowed)).toBe(false);
        expect(shouldBlockNavigation(make("https://elsewhere.test/", { frame: () => subFrame }), allowed)).toBe(false);
    });
    it("refuses a main-page navigation to a host that is not allowed", () => {
        expect(shouldBlockNavigation(make("https://elsewhere.test/"), allowed)).toBe(true);
    });
    it("does not throw when Playwright cannot give the frame (the crash seen on a shared server) and still applies the host rule", () => {
        expect(() => shouldBlockNavigation(make("http://app.test:3000/", { frame: notAvailable }), allowed)).not.toThrow();
        expect(shouldBlockNavigation(make("http://app.test:3000/", { frame: notAvailable }), allowed)).toBe(false);
        expect(shouldBlockNavigation(make("https://elsewhere.test/", { frame: notAvailable }), allowed)).toBe(true);
    });
    it("lets non-web and non-URL requests through", () => {
        expect(shouldBlockNavigation(make("about:blank"), allowed)).toBe(false);
        expect(shouldBlockNavigation(make("not a url"), allowed)).toBe(false);
    });
});
