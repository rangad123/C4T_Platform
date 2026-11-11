/** Plain-language wording for storage and retention. Pure. */
import type { RetentionPolicy } from "./policy.js";
import type { PrunePlan } from "./rules.js";

const UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/** "0 bytes", "812 KB", "1.8 GB". Binary units (1 KB = 1024 bytes), one decimal place from MB up. */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 bytes";
    let v = n;
    let u = 0;
    while (v >= 1024 && u < UNITS.length - 1) {
        v /= 1024;
        u++;
    }
    if (u === 0) return `${Math.round(v)} ${v === 1 ? "byte" : "bytes"}`;
    const text = u >= 2 && v < 100 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
    return `${text} ${UNITS[u]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatDate(iso: string | number): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "an unknown date";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** What a kind of file is called in a sentence. */
export const FILE_NAMES: Record<string, string> = {
    screenshot: "screenshot",
    video: "recording",
    trace: "detailed trace",
    evidence: "list of network calls and console messages",
    "visual-actual": "new screenshot",
    "visual-diff": "comparison image",
    "vision-shot": "screenshot",
};

/** "This recording was removed to save space on Oct 5, 2026." The kind may be any stored kind. */
export function prunedMessage(kind: string, prunedAt: string): string {
    const name = FILE_NAMES[kind] ?? "file";
    return `This ${name} was removed to save space on ${formatDate(prunedAt)}.`;
}

/** The sentence under the Preview button. */
export function previewSentence(plan: Pick<PrunePlan, "files" | "bytes" | "byReason">, policy: RetentionPolicy): string {
    if (plan.files === 0) return "Nothing to remove right now. Every file is newer than the limit or is being kept for a reason.";
    const parts: string[] = [];
    if (plan.byReason.age > 0) parts.push(`${policy.keepDays} days for passed runs`);
    if (plan.byReason["age-failed"] > 0) parts.push(`${policy.keepFailedDays} days for failed runs`);
    if (plan.byReason["size-cap"] > 0) parts.push(`the ${policy.maxArtifactMB} MB size limit`);
    const why = parts.length ? `, to keep within ${parts.join(" and ")}` : "";
    const head = plan.byReason.age + plan.byReason["age-failed"] === plan.files && policy.maxArtifactMB == null ? ` older than ${policy.keepDays === policy.keepFailedDays ? `${policy.keepDays} days` : `${policy.keepDays} days (${policy.keepFailedDays} for failed runs)`}` : "";
    return `This would remove ${plural(plan.files, "file")} (${formatBytes(plan.bytes)})${head || why}.`;
}
