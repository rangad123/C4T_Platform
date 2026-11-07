/**
 * The project's accounts reach an environment only on the project's own site: the same host or another host under the same
 * site (a staging address). Anywhere else the environment needs its own accounts.
 */
import { describe, expect, it } from "vitest";
import { projectAccountsReach } from "../src/platform/environment-run.js";

describe("which environments get the project's accounts", () => {
    it("sends them to the project's own site and nowhere else", () => {
        expect(projectAccountsReach("https://shop.example.com", { baseUrl: "https://staging.shop.example.com", apiBaseUrl: null })).toBe(true);
        expect(projectAccountsReach("https://shop.example.com", { baseUrl: "https://shop.example.com/eu", apiBaseUrl: null })).toBe(true);
        expect(projectAccountsReach("https://app.example.co.uk", { baseUrl: "https://staging.example.co.uk", apiBaseUrl: null })).toBe(true);
        expect(projectAccountsReach("http://127.0.0.1:3000", { baseUrl: "http://127.0.0.1:4000", apiBaseUrl: null })).toBe(true);
        expect(projectAccountsReach("https://shop.example.com", { baseUrl: "https://shop.example.net", apiBaseUrl: null })).toBe(false);
        expect(projectAccountsReach("https://app.example.co.uk", { baseUrl: "https://other.co.uk", apiBaseUrl: null })).toBe(false);
        // every address of the environment must be on the site, its API address too
        expect(projectAccountsReach("https://shop.example.com", { baseUrl: "https://staging.example.com", apiBaseUrl: "https://api.elsewhere.io" })).toBe(false);
        expect(projectAccountsReach("not an address", { baseUrl: "https://shop.example.com", apiBaseUrl: null })).toBe(false);
    });
});
