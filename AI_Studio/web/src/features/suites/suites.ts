/** Types and wording of the test suites a person builds (see src/platform/routes/suites.ts). */
import type { Job, ValidationStatus } from "../../api";
import type { VariantId } from "../variants/variants";

export interface SuiteSettings {
    /** A named environment of the project, or null for the project's own address. */
    environment: string | null;
    confirmProduction: boolean;
    browsers: VariantId[];
    retries: number;
    stopOnFirstFailure: boolean;
}

export interface Suite {
    id: string;
    projectId: string;
    name: string;
    description: string;
    settings: SuiteSettings;
    testCount: number;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SuiteRun {
    jobId: string;
    trigger: "manual" | "schedule";
    scheduleId: string | null;
    testCount: number;
    createdAt: string;
    job: Job;
}

export type CanRun = { ok: true } | { ok: false; reason: string };

export interface SuiteList {
    suites: Array<Suite & { lastRun: SuiteRun | null }>;
    /** The groups by area the platform makes for you. */
    automatic: Array<{ id: string; name: string; slug: string; total: number; validated: number }>;
    canRun: CanRun;
    limits: { suitesPerProject: number; testsPerSuite: number; nameLength: number; descriptionLength: number };
}

export interface SuiteTest {
    id: string;
    testId: string;
    title: string;
    kind: string;
    type: string;
    priority: string;
    area: string;
    framework: string;
    validationStatus: ValidationStatus;
    validationReason: string | null;
}

export interface SuiteDetailData {
    suite: Suite;
    tests: SuiteTest[];
    runs: SuiteRun[];
    schedules: Array<{ id: string; name: string; enabled: boolean }>;
    canRun: CanRun;
    /** Where this project's tests run, in words (the platform or a runner). */
    where: string | null;
}

/** One line saying how the suite runs, in plain words. */
export function settingsSentence(s: SuiteSettings, browserLabel: (id: string) => string): string {
    const parts = [s.environment ? `Runs against “${s.environment}”` : "Runs against the project’s own address"];
    if (s.browsers.length) parts.push(`also on ${s.browsers.map(browserLabel).join(", ")}`);
    if (s.retries) parts.push(`a failing test is run again ${s.retries === 1 ? "once" : "twice"}`);
    if (s.stopOnFirstFailure) parts.push("stops at the first failure");
    return `${parts.join(", ")}.`;
}

/** The order after moving the test at `from` to `to` (both indexes in the current order). */
export function moved<T>(list: T[], from: number, to: number): T[] {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
}

/** How a finished or running suite run went, in a few words. */
export function runResult(r: SuiteRun): string {
    const c = r.job.counters;
    const done = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(r.job.status);
    if (!done) return r.job.status === "QUEUED" ? `${r.testCount} tests waiting to start` : `${r.testCount} tests running`;
    const ran = c.testsValidated + c.testsFailedValidation + c.testsNeedingReview;
    if (ran === 0) return "No test reached a result";
    const bits = [`${c.testsValidated} passed`];
    if (c.testsFailedValidation) bits.push(`${c.testsFailedValidation} failed`);
    if (c.testsNeedingReview) bits.push(`${c.testsNeedingReview} found a problem`);
    return `${bits.join(", ")} of ${r.testCount}`;
}
