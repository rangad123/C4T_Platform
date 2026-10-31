import { describe, expect, it } from "vitest";
import { isLoopbackHost, viewerIsRemote } from "../web/src/lib/viewer.js";

describe("is the person using the platform from another computer", () => {
    it("treats this computer's own addresses as local", () => {
        for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "[::1]", "::1", "app.localhost"]) expect(isLoopbackHost(h), h).toBe(true);
    });
    it("treats every other address as remote: a shared link, a LAN address, a server name", () => {
        for (const h of ["casting-allowed-numbers-diane.trycloudflare.com", "192.168.1.20", "10.0.0.5", "tests.example.com", "my-laptop.local"]) expect(isLoopbackHost(h), h).toBe(false);
    });
    it("viewerIsRemote follows the host name and the ?remote=1 override in the page address", () => {
        expect(viewerIsRemote("127.0.0.1", "#/projects/x/record")).toBe(false);
        expect(viewerIsRemote("127.0.0.1", "#/projects/x/record?remote=1")).toBe(true);
        expect(viewerIsRemote("tests.example.com", "#/projects/x/record")).toBe(true);
        expect(viewerIsRemote("127.0.0.1", "#/projects/x/record?session=abc")).toBe(false);
    });
});
