/**
 * The platform server's own outbound calls on a company network (AI model providers, webhooks and notifications, issue trackers and
 * the other integrations: everything that goes through Node's fetch or http(s).request): called once where the server and the
 * standalone worker start (src/main.ts, src/worker-main.ts).
 *
 * - Proxy: HTTPS_PROXY / HTTP_PROXY / NO_PROXY (either case) send Node's fetch and http(s).request through the proxy
 *   (engine/net/company-network.ts). This computer's own addresses are always reached directly. Unset: nothing changes.
 * - Certificates: the computer's certificate store is trusted besides Node's own list (AITP_SYSTEM_CA=0 turns that off);
 *   NODE_EXTRA_CA_CERTS keeps working. A company security tool that re-signs https traffic is trusted once its root certificate
 *   is in the store or in NODE_EXTRA_CA_CERTS.
 * Not covered: email (SMTP and IMAP connect directly), and the platform's own test browser, which follows its own proxy rules.
 * A proxy password is never printed: the start-up line shows the address as http://user:***@host:port.
 */
import { applyGlobalProxy, applyTrust, bypassEntries, parseProxyAddress, proxyEnvOf, withLoopbackBypass, type ProxyEnv } from "../engine/net/company-network.js";

const falsy = (v: string | undefined): boolean => v !== undefined && /^(0|false|no|off)$/i.test(v.trim());

/** Apply the settings and return the lines to print (each starts with "[network]"). Never includes a password. */
export function applyServerNetwork(env: NodeJS.ProcessEnv = process.env): string[] {
    const lines: string[] = [];
    const pe = proxyEnvOf(env);
    const chosen: ProxyEnv = {};
    for (const [key, name] of [["https", "HTTPS_PROXY"], ["http", "HTTP_PROXY"]] as const) {
        const raw = pe[key];
        if (!raw) continue;
        const p = parseProxyAddress(raw);
        if (p.ok) chosen[key] = p.proxy.url;
        else lines.push(`[network] ${name} could not be used: ${p.message} Outbound calls go directly.`);
    }
    if (chosen.https || chosen.http) {
        chosen.noProxy = withLoopbackBypass(pe.noProxy);
        const applied = applyGlobalProxy(chosen);
        const shown = parseProxyAddress((chosen.https ?? chosen.http)!);
        if (!applied.ok) lines.push(`[network] ${applied.note}`);
        else lines.push(`[network] Outbound calls (AI models, webhooks, notifications, issue trackers) go through the proxy ${shown.ok ? shown.proxy.display : "(set)"}. Reached directly: ${bypassEntries(chosen.noProxy).join(", ")}.`);
    }
    const t = applyTrust({ system: !falsy(env.AITP_SYSTEM_CA), pems: [] });
    for (const n of t.notes) lines.push(`[network] ${n}`);
    if (!falsy(env.AITP_SYSTEM_CA) && t.notes.length === 0) lines.push(`[network] Trusting this computer's certificate store as well as Node.js's own certificates${t.extra ? " and NODE_EXTRA_CA_CERTS" : ""}.`);
    return lines;
}
