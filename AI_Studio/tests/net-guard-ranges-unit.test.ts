/** platform/net-guard.ts isPrivateHost: the ranges that are never a public application. */
import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../src/platform/net-guard.js";

describe("isPrivateHost", () => {
    it("counts benchmarking, multicast, reserved and broadcast IPv4 as not public", () => {
        for (const h of ["198.18.0.1", "198.19.255.254", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"]) expect(isPrivateHost(h), h).toBe(true);
        for (const h of ["198.17.0.1", "198.20.0.1", "223.255.255.1", "8.8.8.8"]) expect(isPrivateHost(h), h).toBe(false);
    });

    it("reads the IPv4 inside IPv4-compatible and NAT64 IPv6 addresses", () => {
        for (const h of ["::7f00:1", "::127.0.0.1", "::a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1"]) expect(isPrivateHost(h), h).toBe(true);
        for (const h of ["::808:808", "64:ff9b::808:808", "2606:4700::1111"]) expect(isPrivateHost(h), h).toBe(false);
        expect(isPrivateHost("::1")).toBe(true);
        expect(isPrivateHost("::")).toBe(true);
    });
});
