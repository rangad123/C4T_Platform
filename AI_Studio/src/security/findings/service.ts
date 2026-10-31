/**
 * What people do with findings: change the validation state (with a comment, kept in the history), and enter findings by hand (from the
 * client's own tools). Both redact exactly as ingest does. The routes (../routes/findings.ts) call these after checking the caller's
 * role and that the objects belong to the project.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CATEGORIES, CONFIDENCES, SEVERITIES, VALIDATION_STATES, type Evidence, type SecurityApplication, type SecurityFinding, type ValidationState } from "../contract.js";
import type { SecurityStore } from "../store.js";
import { fingerprintOf, normalizeLocation } from "./normalize.js";
import { redactEvidence, redactText } from "./redact.js";

/** Leaving these states needs no reason, entering them does: a person's judgement that overrides the evidence must be explained. */
export const NEEDS_REASON: readonly ValidationState[] = ["false-positive", "accepted-risk"];

export const ValidationPatch = z
    .object({
        validation: z.enum(VALIDATION_STATES),
        comment: z.string().trim().max(2000).optional().nullable(),
    })
    .strict();

export class FindingError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/** Change a finding's validation state. Returns the updated finding; the store keeps who, when, from, to and the comment. */
export function changeValidation(store: SecurityStore, finding: SecurityFinding, patch: z.infer<typeof ValidationPatch>): SecurityFinding {
    const comment = patch.comment ? redactText(patch.comment, 2000) : null;
    if (NEEDS_REASON.includes(patch.validation) && !comment) {
        throw new FindingError(400, `Say why this finding is ${patch.validation === "false-positive" ? "a false positive" : "an accepted risk"}: add a comment.`);
    }
    if (patch.validation === finding.validation) {
        if (!comment) throw new FindingError(400, "The finding already has this state. Add a comment to note something without changing it.");
        store.addFindingNote(finding.id, comment);
        return store.getFinding(finding.id)!;
    }
    return store.setValidation(finding.id, patch.validation, { comment })!;
}

const text = (max: number) => z.string().trim().min(1).max(max);
export const ManualFinding = z
    .object({
        title: text(300),
        category: z.enum(CATEGORIES),
        severity: z.enum(SEVERITIES),
        confidence: z.enum(CONFIDENCES).default("medium"),
        location: text(2000),
        description: text(8000),
        impact: text(8000),
        remediation: text(8000),
        reproduction: z.string().trim().max(8000).optional().nullable(),
        evidence: z
            .array(
                z
                    .object({
                        kind: z.enum(["response-header", "cookie", "status", "body-excerpt", "tls", "note"]),
                        label: text(200),
                        value: z.string().max(4000),
                        observedAt: z.string().max(40).optional(),
                    })
                    .strict(),
            )
            .max(20)
            .default([]),
        /** Where the finding came from ("the client's scanner report of 3 May"): kept as a note in the evidence. */
        sourceNote: z.string().trim().max(500).optional().nullable(),
        validation: z.enum(VALIDATION_STATES).default("needs-review"),
        comment: z.string().trim().max(2000).optional().nullable(),
    })
    .strict();

/** Store a finding entered by a person for `app`. Never merged with another finding (each entry gets its own fingerprint). */
export function createManualFinding(store: SecurityStore, app: SecurityApplication, input: z.infer<typeof ManualFinding>): SecurityFinding {
    if (NEEDS_REASON.includes(input.validation) && !input.comment) {
        throw new FindingError(400, `Say why this finding is ${input.validation === "false-positive" ? "a false positive" : "an accepted risk"}: add a comment.`);
    }
    if (store.countFindingsOfApplication(app.id) >= 5000) throw new FindingError(409, "This application already has 5000 findings, the most it can keep. Remove the application's old findings first.");
    const now = new Date().toISOString();
    const location = /^https?:\/\//i.test(input.location) ? normalizeLocation(input.location) : redactText(input.location, 2000);
    const evidence: Evidence[] = [
        ...input.evidence.map((e) => redactEvidence({ ...e, observedAt: e.observedAt && !Number.isNaN(Date.parse(e.observedAt)) ? new Date(e.observedAt).toISOString() : now })),
        ...(input.sourceNote ? [redactEvidence({ kind: "note", label: "Source", value: input.sourceNote, observedAt: now })] : []),
    ];
    const { finding } = store.upsertFinding({
        projectId: app.projectId,
        applicationId: app.id,
        assessmentId: null,
        fingerprint: fingerprintOf(input.category, "manual", randomUUID(), location),
        checkId: null,
        title: redactText(input.title, 300),
        category: input.category,
        severity: input.severity,
        confidence: input.confidence,
        location,
        description: redactText(input.description),
        impact: redactText(input.impact),
        remediation: redactText(input.remediation),
        reproduction: input.reproduction ? redactText(input.reproduction) : null,
        evidence,
        source: "manual",
        initialValidation: input.validation,
        seenAt: now,
    });
    store.addFindingNote(finding.id, input.comment ? `Entered by hand. ${redactText(input.comment, 1900)}` : "Entered by hand.");
    return finding;
}
