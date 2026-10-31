/**
 * Business severity of an application finding (a test in NEEDS_REVIEW), so reviewers know what to
 * look at first. Deterministic and derived from facts already recorded — the finding type and the
 * importance of the journey it broke — so it is computed on read and re-scores old findings when
 * the rules change.
 *
 * Written independently: autonomous-qa-agent has a severity scorer, but that repository has no
 * license, so none of it was used.
 *
 * FAILED_VALIDATION is a broken *test*, not an application defect, and gets no severity.
 */
import type { Priority, TestSpec } from "../spec/schema.js";
import { HEALTH_BASIS } from "../health/checks.js";
import { parseHealthReason } from "../health/specs.js";
import { CONTRACT_BASIS } from "../contracts/check.js";
import { ACCESS_BASIS, parseAccessReason } from "../identity/access.js";
import { parseContractReason } from "../contracts/specs.js";
import { INPUT_BASIS } from "../inputs/checks.js";
import { parseInputReason } from "../inputs/specs.js";
import { parseVisionReason } from "../vision/specs.js";
import { VISION_BASIS } from "../vision/verdict.js";
import { PERFORMANCE_BASIS } from "../performance/checks.js";
import { LATENCY_BASIS, parseLatencyReason } from "../performance/latency.js";
import { LOAD_BASIS, parseLoadReason } from "../performance/load.js";
import { parsePerformanceReason } from "../performance/specs.js";
import { SECURITY_BASIS } from "../security/checks.js";
import { parseSecurityReason } from "../security/specs.js";
import { phoneQualitySeverity } from "../mobile/quality/findings.js";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface SeverityAssessment {
    severity: Severity;
    /** Short, factual basis for the score (shown next to it). */
    basis: string;
}

const BY_PRIORITY: Record<Priority, Severity> = { critical: "critical", high: "high", medium: "medium", low: "low" };

function raise(s: Severity): Severity {
    return SEVERITIES[Math.max(0, SEVERITIES.indexOf(s) - 1)]!;
}

export function assessSeverity(spec: TestSpec, validationStatus: string, reason: string | null | undefined): SeverityAssessment | undefined {
    if (validationStatus !== "NEEDS_REVIEW") return undefined;
    const r = reason ?? "";

    // Deterministic passive-security and page-health checks tag every problem with its own severity
    // ("- [high] ..."), so the finding is as severe as its worst problem.
    const sec = parseSecurityReason(r);
    if (sec.check) return { severity: sec.severity ?? "low", basis: SECURITY_BASIS[sec.check] };
    const worstHealth = parseHealthReason(r)
        .filter((h) => h.severity)
        .sort((a, b) => SEVERITIES.indexOf(a.severity!) - SEVERITIES.indexOf(b.severity!))[0];
    if (worstHealth) return { severity: worstHealth.severity!, basis: worstHealth.check ? HEALTH_BASIS[worstHealth.check] : "page health problem" };

    const access = parseAccessReason(r);
    if (access) return { severity: access, basis: ACCESS_BASIS };
    const contract = parseContractReason(r);
    if (contract) return { severity: contract, basis: CONTRACT_BASIS };
    const vision = parseVisionReason(r);
    if (vision) return { severity: vision, basis: VISION_BASIS };
    const input = parseInputReason(r);
    if (input) return { severity: input, basis: INPUT_BASIS };
    const latency = parseLatencyReason(r);
    if (latency) return { severity: latency, basis: LATENCY_BASIS };
    const load = parseLoadReason(r);
    if (load) return { severity: load, basis: LOAD_BASIS };
    const perf = parsePerformanceReason(r);
    if (perf) return { severity: perf, basis: PERFORMANCE_BASIS };
    // Phone quality checks: a crash or freeze is high, a slow cold start medium, phone accessibility as its worst problem.
    const phone = phoneQualitySeverity(r);
    if (phone) return phone;

    // Documented authentication not enforced: data exposure, regardless of journey priority.
    if (/possible security issue/i.test(r)) return { severity: "critical", basis: "authentication not enforced" };

    // A server error on a core journey breaks it; elsewhere it is still a crash.
    if (/server error/i.test(r)) {
        return spec.priority === "critical"
            ? { severity: "critical", basis: "server error on a critical journey" }
            : { severity: "high", basis: "server error (5xx)" };
    }

    // A page that no longer matches its approved screenshot: worth a look, rarely an outage.
    if (/^visual change/i.test(r)) return { severity: "low", basis: "visual change from the approved baseline" };

    // Accessibility: map the worst axe impact reported in the failure message.
    if (spec.type === "accessibility" || /accessibility audit failed/i.test(r)) {
        if (/\[critical\]/.test(r)) return { severity: "high", basis: "critical accessibility violation (blocks some users)" };
        if (/\[serious\]/.test(r)) return { severity: "medium", basis: "serious accessibility violation" };
        return { severity: "low", basis: "minor/moderate accessibility violation" };
    }

    // Functional defect found by the authoring agent or triage: as important as the journey it broke;
    // one step higher for security-type tests.
    const base = BY_PRIORITY[spec.priority];
    return spec.type === "security"
        ? { severity: raise(base), basis: `security test failed on a ${spec.priority}-priority journey` }
        : { severity: base, basis: `defect on a ${spec.priority}-priority journey` };
}
