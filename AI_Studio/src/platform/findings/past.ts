/**
 * The project's past findings by where they happened, for impact analysis (engine/impact/analyze.ts) and the risk score's "previous
 * defects" (selection/risk.ts): the findings list's candidate findings (S2), the endpoints from their recorded requests and the pages
 * their test opens. A finding a person judged not a bug, or a duplicate, is not a past defect. Security findings name no endpoint or
 * page in the findings view, so they are not linked here.
 */
import type { PastFinding } from "../../engine/impact/analyze.js";
import { CandidateFindingStore } from "../candidate-finding-store.js";
import type { Repo } from "../repo.js";
import type { Sql } from "../sql.js";

/** "POST /api/cart -> 500" → method, address and status. */
const REQUEST = /^([A-Z]{3,7})\s+(\S+)(?:\s*->\s*(\d{3}))?/;

export async function pastFindings(sql: Sql, repo: Repo, projectId: string): Promise<PastFinding[]> {
    const out: PastFinding[] = [];
    for (const r of await new CandidateFindingStore(sql).list(projectId)) {
        if (r.state === "not_a_bug" || r.state === "duplicate") continue;
        const requests = r.finding.evidence.requests.flatMap((line) => {
            const m = REQUEST.exec(line.trim());
            return m ? [{ endpoint: `${m[1]} ${m[2]}`, failed: m[3] !== undefined && Number(m[3]) >= 400 }] : [];
        });
        // The requests that failed are where it happened; without a failed one, every request the finding recorded.
        const failed = requests.filter((q) => q.failed);
        const endpoints = [...new Set((failed.length ? failed : requests).map((q) => q.endpoint))];
        const test = r.testId ? repo.getTest(r.testId) : undefined;
        const pages = test && test.projectId === projectId && !test.unreadable ? [...new Set(test.spec.steps.flatMap((s) => (s.action === "navigate" ? [s.url] : [])))] : [];
        if (endpoints.length || pages.length) out.push({ id: r.id, title: test?.title ?? r.finding.expected.text, endpoints, pages });
    }
    return out;
}
