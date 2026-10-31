import { describe, expect, it } from "vitest";
import { isApiRequest, isFrameworkPageRequest } from "../src/engine/discovery/network.js";

describe("what counts as an API call when exploring an app", () => {
    it("keeps real API calls", () => {
        expect(isApiRequest("https://app.test/api/auth/me", "fetch")).toBe(true);
        expect(isApiRequest("https://app.test/api/products?page=2", "xhr")).toBe(true);
        expect(isApiRequest("https://app.test/graphql", "fetch")).toBe(true);
        expect(isApiRequest("https://app.test/data.json", "xhr")).toBe(true);
    });
    it("ignores a framework fetching its own pages (the Next.js page payload that redirected and produced a test expecting a 2xx)", () => {
        expect(isFrameworkPageRequest("https://app.test/account?_rsc=1r34m")).toBe(true);
        expect(isApiRequest("https://app.test/account?_rsc=1r34m", "fetch")).toBe(false);
        expect(isApiRequest("https://app.test/_next/data/abc123/en/pricing.json", "fetch")).toBe(false);
        expect(isApiRequest("https://app.test/products?_data=routes%2Fproducts", "fetch")).toBe(false);
    });
    it("still ignores requests that are not fetch or xhr", () => {
        expect(isApiRequest("https://app.test/api/x", "image")).toBe(false);
        expect(isApiRequest("not a url", "fetch")).toBe(false);
    });
    it("does not treat an API path that merely contains the word as a page request", () => {
        expect(isFrameworkPageRequest("https://app.test/api/_rsc_stats")).toBe(false);
    });
});
