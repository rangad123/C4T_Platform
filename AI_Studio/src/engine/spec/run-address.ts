/**
 * Every address a test opens or calls is checked at the moment the step runs.
 *
 * Why this exists: an address is checked when a test is saved, but then it can still hold `{{placeholders}}`, and a data set row, an environment
 * variable or a captured value decides the rest when the test runs. `f{{p}}` with the value `ile:///etc/hosts` is a file: address by then. So:
 *   - in the generated script (`RUN_ADDRESS_HELPER_SOURCE`), `allowedAddress` judges the finished address right before each navigate and request;
 *   - the same text compiled here (`checkedAddress`) judges the steps the platform drives itself while the AI writes a test;
 *   - at save, `placeholderCanMoveAddress` refuses a placeholder that could change the scheme or the host, while private targets are blocked.
 *
 * The verdict is the outbound guard's (`assertAllowedTarget`, platform/net-guard.ts): http(s) only, the application's own site always passes, and
 * with BLOCK_PRIVATE_TARGETS=true nothing else may be loopback, a private range or a link-local address (169.254.169.254), by name or by what
 * the name resolves to. A test run by a runner agent uses the agent's own setting, as the agent's network is its owner's.
 */
import { lookup } from "node:dns/promises";

/** Starts every refusal of this rule; tests and the docs rely on the wording. */
export const RUN_ADDRESS_RULE = "This address cannot be used by a test";

/** The one import of the helper: it looks a name up, nothing else. The guard for hand-written scripts allows it so a taken-over script still runs. */
export const RUN_ADDRESS_MODULE = "node:dns/promises";
export const RUN_ADDRESS_IMPORT = `import { lookup as addressLookup } from "${RUN_ADDRESS_MODULE}";\n`;

/**
 * Plain JavaScript on purpose (no type annotations): the text is pasted into generated scripts and also compiled with `new Function`, so the
 * platform and its tests run the exact helper the scripts carry. A script has no access to platform/net-guard.ts, so `privateAddress` repeats
 * `isPrivateHost` (tests/run-address-unit.test.ts holds the two together).
 */
export const RUN_ADDRESS_HELPER_SOURCE = String.raw`/** The rule of platform/net-guard.ts, for an address read by the URL parser. */
function privateAddress(raw) {
    const h = String(raw).toLowerCase().replace(/\.$/, "");
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
    const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
    if (v4) {
        const a = Number(v4[1]);
        const b = Number(v4[2]);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    if (!h.includes(":")) return false;
    // IPv4-mapped (::ffff:), the old IPv4-compatible form (::) and NAT64 (64:ff9b::) carry an IPv4 address: judged as that address.
    const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex) {
        const x = parseInt(hex[1], 16);
        const y = parseInt(hex[2], 16);
        return privateAddress([x >> 8, x & 255, y >> 8, y & 255].join("."));
    }
    const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (dotted) return privateAddress(dotted[1]);
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || /^fe[89a-f]/.test(h) || h.startsWith("ff");
}

/** The finished address of a step, as the browser or the request will use it. Throws before anything is opened or sent. */
async function allowedAddress(address, base) {
    const denied = (why) => new Error(${JSON.stringify(RUN_ADDRESS_RULE)} + ": " + why + " Nothing was opened or sent.");
    let target;
    try {
        target = new URL(String(address), base);
    } catch {
        throw denied("it is not a valid address.");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw denied("only http and https addresses can be used, not " + target.protocol);
    let own = "";
    try {
        own = new URL(String(base)).origin;
    } catch {
        // a base that cannot be read has no site of its own
    }
    if (target.origin === own || process.env.BLOCK_PRIVATE_TARGETS !== "true") return target.toString();
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const found = host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? [] : await addressLookup(host, { all: true }).catch(() => []);
    if (privateAddress(host) || found.some((a) => privateAddress(a.address))) throw denied(target.host + " is a private or loopback address.");
    return target.toString();
}
`;

type Lookup = (host: string, o: { all: true }) => Promise<Array<{ address: string }>>;
export interface RunAddressRuntime {
    allowedAddress(address: string, base: string): Promise<string>;
    privateAddress(host: string): boolean;
}

/** The helper compiled (the exact text scripts carry). Tests hand in their own `lookup`. */
export function loadRunAddressRuntime(addressLookup: Lookup = lookup): RunAddressRuntime {
    return new Function("addressLookup", `${RUN_ADDRESS_HELPER_SOURCE}\nreturn { allowedAddress, privateAddress };`)(addressLookup) as RunAddressRuntime;
}

let runtime: RunAddressRuntime | undefined;

/** For a step the platform opens itself (the AI writing a test): the same verdict, the same message. */
export function checkedAddress(address: string, base: string): Promise<string> {
    runtime ??= loadRunAddressRuntime();
    return runtime.allowedAddress(address, base);
}

/**
 * Could a `{{placeholder}}` in this address change its scheme or its host? True for one in front of the end of the host, and for one right
 * after a first `/` or after text that could still be a scheme (`/{{p}}` with `/evil.example` is `//evil.example`; `f{{p}}` with `ile:///x` is a
 * file: address). Backslashes count as `/`, and tabs and line breaks are dropped, as the URL parser does.
 */
export function placeholderCanMoveAddress(value: string): boolean {
    const text = value.replace(/[\t\r\n]/g, "").replace(/\\/g, "/").trim();
    const at = text.indexOf("{{");
    if (at < 0) return false;
    const before = text.slice(0, at);
    const hostIsDone = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]+[/?#]/i.test(before);
    const inPathOrQuery = /^\/[^/]/.test(before) || /^[^/:?#]+\//.test(before) || /^[^/:?#]*[?#]/.test(before);
    return !hostIsDone && !inPathOrQuery;
}
