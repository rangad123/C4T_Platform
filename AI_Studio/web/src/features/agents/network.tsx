/** A runner's network in plain words: the proxy it connects through and its last network problem (docs/features/company-networks.md). */
import { relativeTime } from "../../lib/format";
import type { RunnerNetwork } from "./agents";

const SOURCE: Record<NonNullable<RunnerNetwork["proxySource"]>, string> = {
    flag: "set when the runner was started",
    env: "from the computer's proxy variables",
    file: "from runner.json",
    windows: "from the Windows proxy setting",
};

/** One sentence: "Connects through the proxy proxy.corp:8080, from the Windows proxy setting. Tests reach the application directly." */
export function networkSentence(n: RunnerNetwork): string {
    const parts: string[] = [];
    if (n.proxy) {
        parts.push(`Connects through the proxy ${n.proxy}${n.proxySource ? `, ${SOURCE[n.proxySource]}` : ""}.`);
        parts.push(n.proxyTests ? "Tests go through it too." : "Tests reach the application directly.");
    } else parts.push("Connects directly, no proxy.");
    const trusts: string[] = [];
    if (n.certificates?.includes("system")) trusts.push("this computer's certificates");
    if (n.certificates?.includes("file")) trusts.push("a company certificate file");
    if (n.certificates?.includes("extra")) trusts.push("NODE_EXTRA_CA_CERTS");
    if (trusts.length) parts.push(`Also trusts ${trusts.join(" and ")}.`);
    return parts.join(" ");
}

/** The runner's last network problem (at most an hour old), as a note on its row. Nothing when there is none. */
export function RunnerNetworkProblem({ network }: { network?: RunnerNetwork }) {
    if (!network?.problem) return null;
    return (
        <p className="t-secondary" data-testid="agent-network-problem">
            Network problem{network.problemAt ? ` ${relativeTime(network.problemAt)}` : ""}: {network.problem}
        </p>
    );
}
