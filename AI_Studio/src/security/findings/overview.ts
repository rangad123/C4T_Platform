/**
 * The project's security overview and its risk rules. The rules are plain and written into every answer and report, so a reader can
 * check the level by hand: there is deliberately no single "secure" score, and "no open findings" never means "secure" (it covers
 * only what a passive assessment looked at).
 */
import type { AssessmentState, SecurityApplication, SecurityAssessment, SecurityFinding, Severity } from "../contract.js";
import { SEVERITIES } from "../contract.js";

export const OPEN_VALIDATIONS = ["confirmed", "probable", "needs-review"] as const;
export const isOpenFinding = (f: Pick<SecurityFinding, "validation">) => (OPEN_VALIDATIONS as readonly string[]).includes(f.validation);

export type RiskLevel = "not-assessed" | "high" | "medium" | "low" | "no-open-findings";

/** The rules, in the order they are applied. Shown in the API answer, the in-app overview and every report. */
export const RISK_RULES: readonly string[] = [
    "Only open findings count: confirmed, probable and needs review. False positives, accepted risks and fixed findings do not.",
    "High risk: at least one open critical or high finding.",
    "Medium risk: no open critical or high finding, and at least one open medium finding.",
    "Low risk: only open low or informational findings.",
    "No open findings: nothing open was found by the checks that ran. This is not a statement that the application is secure; see what was not inspected.",
    "Not assessed: no assessment of this project has finished yet.",
];

export const RISK_WORDS: Record<RiskLevel, string> = {
    "not-assessed": "Not assessed",
    high: "High risk",
    medium: "Medium risk",
    low: "Low risk",
    "no-open-findings": "No open findings",
};

export interface RiskOverview {
    level: RiskLevel;
    label: string;
    /** Why this level, in one sentence naming the counts. */
    reason: string;
    openBySeverity: Record<Severity, number>;
    rules: readonly string[];
}

const zero = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

export function assessRisk(findings: Array<Pick<SecurityFinding, "severity" | "validation">>, assessed: boolean): RiskOverview {
    const open = zero();
    for (const f of findings) if (isOpenFinding(f)) open[f.severity]++;
    const n = (s: Severity) => `${open[s]} ${s}`;
    let level: RiskLevel;
    let reason: string;
    if (!assessed && findings.length === 0) {
        level = "not-assessed";
        reason = "No assessment has finished yet and no findings were entered by hand.";
    } else if (open.critical + open.high > 0) {
        level = "high";
        reason = `There ${open.critical + open.high === 1 ? "is" : "are"} ${n("critical")} and ${n("high")} open finding${open.critical + open.high === 1 ? "" : "s"}.`;
    } else if (open.medium > 0) {
        level = "medium";
        reason = `No critical or high finding is open; ${n("medium")} finding${open.medium === 1 ? " is" : "s are"} open.`;
    } else if (open.low + open.info > 0) {
        level = "low";
        reason = `Only low or informational findings are open (${n("low")}, ${n("info")}).`;
    } else {
        level = "no-open-findings";
        reason = "No finding is open. This covers only what was inspected.";
    }
    return { level, label: RISK_WORDS[level], reason, openBySeverity: open, rules: RISK_RULES };
}

export interface OverviewApplication {
    id: string;
    name: string;
    targetUrl: string;
    environment: string;
    lastAssessment: { id: string; state: AssessmentState; finishedAt: string | null; createdAt: string } | null;
    openFindings: number;
}

export interface SecurityOverview {
    risk: RiskOverview;
    counts: {
        applications: number;
        applicationsAssessed: number;
        assessmentsCompleted: number;
        openCriticalHigh: number;
        /** Open findings no person has validated yet (needs review or probable). */
        awaitingReview: number;
        /** Findings a retest showed as gone. */
        fixedAfterRetest: number;
        /** Open findings: the remediation still to do. */
        remediationRemaining: number;
        falsePositives: number;
        acceptedRisks: number;
    };
    applications: OverviewApplication[];
    /** The most serious open findings (at most 10). */
    needsAttention: Array<Pick<SecurityFinding, "id" | "title" | "severity" | "validation" | "location" | "applicationId" | "lastSeenAt">>;
    /** Findings fixed after a retest, newest first (at most 10). */
    fixedRecently: Array<Pick<SecurityFinding, "id" | "title" | "severity" | "location" | "applicationId"> & { fixedAt: string; retestId: string | null }>;
}

export function computeOverview(input: {
    applications: SecurityApplication[];
    assessments: SecurityAssessment[];
    findings: SecurityFinding[];
    /** Finding id → when and by which retest it was marked fixed (from the validation history). */
    fixedByRetest: Map<string, { at: string; retestId: string | null }>;
}): SecurityOverview {
    const { applications, assessments, findings, fixedByRetest } = input;
    const completed = assessments.filter((a) => a.state === "COMPLETED" || a.state === "PARTIALLY_COMPLETED");
    const open = findings.filter(isOpenFinding);
    const latest = (appId: string) =>
        assessments.filter((a) => a.applicationId === appId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const apps: OverviewApplication[] = applications.map((app) => {
        const last = latest(app.id);
        return {
            id: app.id,
            name: app.name,
            targetUrl: app.targetUrl,
            environment: app.environment,
            lastAssessment: last ? { id: last.id, state: last.state, finishedAt: last.finishedAt, createdAt: last.createdAt } : null,
            openFindings: open.filter((f) => f.applicationId === app.id).length,
        };
    });
    const sevRank = (s: Severity) => SEVERITIES.indexOf(s);
    const fixedRecently = findings
        .filter((f) => f.validation === "fixed" && fixedByRetest.has(f.id))
        .map((f) => ({ id: f.id, title: f.title, severity: f.severity, location: f.location, applicationId: f.applicationId, fixedAt: fixedByRetest.get(f.id)!.at, retestId: fixedByRetest.get(f.id)!.retestId }))
        .sort((a, b) => b.fixedAt.localeCompare(a.fixedAt));
    return {
        risk: assessRisk(findings, completed.length > 0),
        counts: {
            applications: applications.length,
            applicationsAssessed: new Set(completed.map((a) => a.applicationId)).size,
            assessmentsCompleted: completed.length,
            openCriticalHigh: open.filter((f) => f.severity === "critical" || f.severity === "high").length,
            awaitingReview: open.filter((f) => f.validation === "needs-review" || f.validation === "probable").length,
            fixedAfterRetest: fixedRecently.length,
            remediationRemaining: open.length,
            falsePositives: findings.filter((f) => f.validation === "false-positive").length,
            acceptedRisks: findings.filter((f) => f.validation === "accepted-risk").length,
        },
        applications: apps,
        needsAttention: open
            .slice()
            .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.lastSeenAt.localeCompare(a.lastSeenAt))
            .slice(0, 10)
            .map((f) => ({ id: f.id, title: f.title, severity: f.severity, validation: f.validation, location: f.location, applicationId: f.applicationId, lastSeenAt: f.lastSeenAt })),
        fixedRecently: fixedRecently.slice(0, 10),
    };
}
