/**
 * Locator-healing proposals: "the button the test looked for is gone; this one is probably it". A proposal is only ever a
 * suggestion stored here - applying it is a person's decision. Also home of migration slot 12's second table group (deploy
 * trigger tokens, see trigger-store.ts), so the whole slot is one SQL string.
 */
import { randomUUID } from "node:crypto";
import type { HealProposal } from "../engine/healing/heal.js";
import { sameLocator } from "../engine/healing/apply.js";
import type { Locator } from "../engine/spec/schema.js";
import type { Db } from "./db.js";
import { TRIGGERS_SQL } from "./trigger-store.js";

/** Migration slot 12. */
export const HEALING_MIGRATION = `
CREATE TABLE healing_proposals (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    job_id TEXT,                          -- the run whose failure produced it
    step_index INTEGER NOT NULL,
    old_locator_json TEXT NOT NULL,
    new_locator_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    confidence_label TEXT NOT NULL,       -- high | medium | low
    reason TEXT NOT NULL,
    old_description TEXT NOT NULL,
    new_description TEXT NOT NULL,
    status TEXT NOT NULL,                 -- proposed | applied | dismissed
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE INDEX idx_healing_test ON healing_proposals(test_case_id, status);
${TRIGGERS_SQL}`;

export type ProposalStatus = "proposed" | "applied" | "dismissed";

export interface StoredProposal {
    id: string;
    testId: string;
    jobId: string | null;
    stepIndex: number;
    oldLocator: Locator;
    newLocator: Locator;
    confidence: number;
    confidenceLabel: "high" | "medium" | "low";
    reason: string;
    oldDescription: string;
    newDescription: string;
    status: ProposalStatus;
    createdAt: string;
    decidedAt: string | null;
}

const toProposal = (r: Record<string, any>): StoredProposal => ({
    id: r.id,
    testId: r.test_case_id,
    jobId: r.job_id,
    stepIndex: r.step_index,
    oldLocator: JSON.parse(r.old_locator_json),
    newLocator: JSON.parse(r.new_locator_json),
    confidence: r.confidence,
    confidenceLabel: r.confidence_label,
    reason: r.reason,
    oldDescription: r.old_description,
    newDescription: r.new_description,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
});

export class HealingStore {
    constructor(private readonly db: Db) {}

    list(testId: string): StoredProposal[] {
        return this.db.all(`SELECT * FROM healing_proposals WHERE test_case_id = ? ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC`, testId).map(toProposal);
    }

    get(id: string): StoredProposal | undefined {
        const r = this.db.get("SELECT * FROM healing_proposals WHERE id = ?", id);
        return r ? toProposal(r) : undefined;
    }

    /** The result of a fresh analysis replaces the suggestions that were still open for the test. Never throws (a heal must not affect a job). */
    record(testId: string, jobId: string | null, proposal: HealProposal | undefined): StoredProposal | undefined {
        try {
            return this.db.tx(() => {
                this.db.run("DELETE FROM healing_proposals WHERE test_case_id = ? AND status = 'proposed'", testId);
                if (!proposal) return undefined;
                // A suggestion the user already dismissed is not made again.
                const dismissed = this.list(testId).some((p) => p.status === "dismissed" && p.stepIndex === proposal.stepIndex && sameLocator(p.oldLocator, proposal.oldLocator) && sameLocator(p.newLocator, proposal.newLocator));
                if (dismissed) return undefined;
                const id = randomUUID();
                this.db.run(
                    "INSERT INTO healing_proposals (id, test_case_id, job_id, step_index, old_locator_json, new_locator_json, confidence, confidence_label, reason, old_description, new_description, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'proposed',?)",
                    id, testId, jobId, proposal.stepIndex, JSON.stringify(proposal.oldLocator), JSON.stringify(proposal.newLocator), proposal.confidence, proposal.confidenceLabel, proposal.reason, proposal.oldDescription, proposal.newDescription, new Date().toISOString(),
                );
                return this.get(id);
            });
        } catch (err) {
            console.error(`[healing] could not store the proposal for test ${testId.slice(0, 8)}:`, err);
            return undefined;
        }
    }

    /** True when the proposal was open and is now decided (guards against two people deciding at once). */
    decide(id: string, status: "applied" | "dismissed"): boolean {
        return Number(this.db.run("UPDATE healing_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'proposed'", status, new Date().toISOString(), id).changes) === 1;
    }
}
