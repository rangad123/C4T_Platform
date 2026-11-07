/**
 * Private and local addresses on a runner: localhost, the computer's own network (10.x, 172.16-31.x, 192.168.x, fc00::/7) and link-local
 * addresses (169.254.x, fe80::). A person's own computer refuses them unless its owner allows them on the Runners page; a team runner keeps
 * allowing them unless an admin switched them off. The platform says which in the hello answer (`runner.privateTargets`) and, when the switch
 * changes, in a heartbeat (`config.privateTargets`). `BLOCK_PRIVATE_TARGETS=true` in the runner's own environment refuses them whatever the
 * platform says (stricter only).
 *
 * When they are refused, two things happen on THIS computer, because names resolve differently here than on the platform:
 *   1. before a web or API run (or a recording) starts, its addresses (the site, the API, every http(s) value of the environment) are looked up
 *      here; a private, loopback or link-local one, or one that cannot be found, refuses the task with a plain sentence;
 *   2. the run's browser and its API calls go through the address guard (engine/discovery/guard-proxy.ts) started inside the agent, which
 *      looks every name up itself and refuses a private address on every request, frame and redirect hop (DNS rebinding included).
 *
 * Not covered, and said so in the docs: a code script (hand-written, imported, Git) is code, and code can open its own connections without
 * the guard. This is not an operating-system sandbox.
 */
import dns from "node:dns/promises";
import net from "node:net";
import type { HelloResponse, WireRunEnv } from "../agent-protocol/schema.js";
import { GuardProxy } from "../engine/discovery/guard-proxy.js";
import { isPrivateHost } from "../platform/net-guard.js";

/** The environment variable that hands the guard's address to the run (engine/net/test-proxy.ts writes it into the run's config). */
export const ADDRESS_GUARD_ENV = "AITP_ADDRESS_GUARD";

/** What the guard answers in place of a refused page, and the end of every refusal sentence. */
export const RUNNER_PRIVATE_REFUSED = "This address is private or local to this computer's network, and this runner does not open those. The runner's owner can allow private addresses on the Runners page.";

const OWNER_NOTE = "This runner does not open private or local addresses (such as localhost or a device on the same network). The runner's owner can allow them on the Runners page.";

/** "host:port" pairs treated as public. Tests only (a local site stands in for a public one); the agent never sets it. */
let testTrust: string[] = [];
export function trustForTests(hostPorts: string[]): void {
    testTrust = [...hostPorts];
}

export type Lookup = (host: string) => Promise<Array<{ address: string }>>;
const systemLookup: Lookup = (host) => dns.lookup(host, { all: true });

/**
 * Does this runner refuse private addresses now? `latest` is what a heartbeat said last (it wins over the hello answer); an older platform
 * that says nothing keeps today's behaviour (allowed), unless this computer's own environment refuses them.
 */
export function refusesPrivateAddresses(hello: Pick<HelloResponse, "runner"> | undefined, latest: { privateTargets?: boolean } | undefined, env: NodeJS.ProcessEnv): boolean {
    if (env.BLOCK_PRIVATE_TARGETS === "true") return true;
    const allowed = latest?.privateTargets ?? hello?.runner?.privateTargets;
    return allowed === false;
}

const portOf = (u: URL): string => u.port || (u.protocol === "https:" ? "443" : "80");

/** Why this address may not be opened from here (a plain sentence), or undefined. Only http(s) addresses are judged; anything else is left to the run. */
export async function addressProblem(raw: string, lookup: Lookup = systemLookup): Promise<string | undefined> {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return undefined;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (testTrust.includes(`${u.hostname}:${portOf(u)}`)) return undefined;
    if (!host) return undefined;
    if (isPrivateHost(host)) return `${u.host} is a private or local address. ${OWNER_NOTE}`;
    if (net.isIP(host)) return undefined;
    const found = await lookup(host).catch(() => []);
    if (found.length === 0) return `${u.host} could not be found from this computer, so the runner could not check that it is not a private address.`;
    if (found.some((a) => isPrivateHost(a.address))) return `${u.host} leads to a private or local address on this computer's network. ${OWNER_NOTE}`;
    return undefined;
}

const looksLikeAddress = (v: string): boolean => /^https?:\/\//i.test(v.trim());

/** Every address a run will open: the site, the API and each http(s) value of the environment (duplicates once). */
export function addressesOf(env: Pick<WireRunEnv, "baseUrl" | "apiBaseUrl" | "vars">): string[] {
    const all = [env.baseUrl, env.apiBaseUrl ?? "", ...Object.values(env.vars ?? {}).filter(looksLikeAddress)].map((v) => v.trim()).filter(Boolean);
    return [...new Set(all)];
}

/** The first refusal among a run's addresses, looked up on this computer, or undefined when every one is public. */
export async function runAddressRefusal(env: Pick<WireRunEnv, "baseUrl" | "apiBaseUrl" | "vars">, lookup: Lookup = systemLookup): Promise<string | undefined> {
    for (const a of addressesOf(env)) {
        const why = await addressProblem(a, lookup);
        if (why) return `The run was not started: ${why}`;
    }
    return undefined;
}

/**
 * A company proxy for the tests (--proxy-tests) and the guard cannot both be used: the proxy looks names up on its own network, so this
 * computer cannot check where a test really goes. The run is refused with what to do instead.
 */
export function proxyTestsConflict(env: NodeJS.ProcessEnv): string | undefined {
    const on = env.AITP_PROXY_TESTS !== undefined && /^(1|true|yes|on)$/i.test(env.AITP_PROXY_TESTS.trim());
    if (!on || !(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY)) return undefined;
    return "The run was not started: this runner sends tests through a company proxy (--proxy-tests) and does not open private addresses, and it cannot check where the proxy sends a test. Allow private addresses for this runner on the Runners page, or start it without --proxy-tests.";
}

/** The guard for one task: started inside the agent on 127.0.0.1, closed when the task ends. */
export function startAddressGuard(): Promise<GuardProxy> {
    return GuardProxy.start({ trust: testTrust, refusal: RUNNER_PRIVATE_REFUSED });
}

/** The run's environment with the guard switched on: every request of the run goes through it, and generated scripts check each step too. */
export function guardedEnv(env: NodeJS.ProcessEnv, guard: Pick<GuardProxy, "address">): NodeJS.ProcessEnv {
    return { ...env, [ADDRESS_GUARD_ENV]: guard.address, BLOCK_PRIVATE_TARGETS: "true" };
}
