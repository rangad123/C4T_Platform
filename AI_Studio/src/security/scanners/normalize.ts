/**
 * Turns what an external scanner reported into the platform's finding pipeline, without weakening any of its rules.
 *
 * One direction only: `scannerFindingToRaw` produces `RawResult`s that `findings/ingest.ts` already knows how to store, so a
 * scanner's findings go through exactly the same redaction, deduplication, retest and history code as the platform's own checks.
 * Nothing here stores anything and nothing here talks to a network.
 *
 * Three jobs, in order:
 *   1. **Severity normalization.** Every tool has its own scale (nuclei says "critical", ZAP says 3, Schemathesis says "error").
 *      `severityOf` maps them onto the platform's five, and never upgrades anything it does not recognise: an unknown word becomes
 *      `info` so an unreadable value cannot silently inflate a report.
 *   2. **Category mapping.** `categoryFor` maps a finding onto the platform's vocabulary (src/security/contract.ts), preferring the
 *      tool's CWE id, then its rule id, then its wording. A category it cannot place becomes `other` rather than a guess.
 *   3. **Identity for deduplication.** `canonicalRule` gives one stable key so that the same problem reported by two tools on the
 *      same address becomes one finding with both references kept, instead of two findings a reader has to merge by hand.
 *
 * Honesty rules that belong here rather than in a report:
 *   - A finding starts `probable` only when it carries direct evidence and the tool rates its confidence high. Everything else starts
 *     `needs-review`. Nothing an external tool reports is ever marked `confirmed`; that stays a person's decision.
 *   - When a tool supplies no impact or no remediation, the finding says so in those words rather than repeating the title.
 *   - The tool's own id and its own evidence are kept verbatim (after redaction), so the original can be reviewed.
 */
import { CATEGORIES, type Confidence, type FindingCategory, type Severity } from "../contract.js";
import type { CustomProblem, RawResult } from "../findings/normalize.js";
import type { ScannerFinding, ScannerId } from "./contract.js";

/** Most findings one scanner run may report (the rest are counted, never silently dropped). */
export const MAX_SCANNER_FINDINGS = 2_000;
/** Most evidence items kept for one scanner finding. */
export const MAX_SCANNER_EVIDENCE = 8;

const SEV_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];

/** The platform's five severities, from a tool's own word or number. Unknown never becomes anything more serious than `info`. */
export function severityOf(toolSeverity: unknown): Severity {
    if (typeof toolSeverity === "number") {
        // ZAP: 3 high, 2 medium, 1 low, 0 informational.
        return (["info", "low", "medium", "high", "critical"] as Severity[])[Math.min(4, Math.max(0, Math.round(toolSeverity)))] ?? "info";
    }
    const s = String(toolSeverity ?? "").trim().toLowerCase();
    if (SEV_ORDER.includes(s as Severity)) return s as Severity;
    if (["unknown", "unconfirmed", "none", ""].includes(s)) return "info";
    if (/^(crit|severe|fatal|blocker)$/.test(s)) return "critical";
    if (/^(error|significant)$/.test(s)) return "high";
    if (/^(warn|warning|moderate|medium)$/.test(s)) return "medium";
    if (/^(note|minor|negligible)$/.test(s)) return "low";
    return "info";
}

/**
 * CWE ids the platform names directly, because they are exact. Anything else is matched on the rule id and then on the wording;
 * a category that cannot be placed becomes `other`, which the report shows as "other" rather than mislabelling it.
 */
const CWE_CATEGORY: Record<string, FindingCategory> = {
    "79": "xss",
    "80": "xss",
    "83": "xss",
    "89": "injection",
    "78": "injection",
    "77": "injection",
    "94": "injection",
    "91": "injection",
    "943": "injection",
    "611": "injection",
    "918": "ssrf",
    "22": "path-traversal",
    "23": "path-traversal",
    "36": "path-traversal",
    "284": "access-control",
    "285": "access-control",
    "639": "access-control",
    "862": "access-control",
    "863": "access-control",
    "306": "access-control",
    "200": "information-disclosure",
    "209": "information-disclosure",
    "215": "information-disclosure",
    "312": "secrets",
    "798": "secrets",
    "259": "configuration",
    "16": "configuration",
    "693": "configuration",
    "352": "access-control",
    "345": "access-control",
    "525": "information-disclosure",
    "538": "secrets",
    "732": "configuration",
};

/** Fallback wording, used only when the CWE and the rule id say nothing. First match wins. */
const WORD_CATEGORY: Array<[RegExp, FindingCategory]> = [
    [/\b(sql ?injection|nosql ?injection|command injection|code injection|template injection|ldap ?injection|xpath|ssti)\b/i, "injection"],
    [/\b(cross[- ]site scripting|xss|script injection|dom sink)\b/i, "xss"],
    [/\b(server[- ]side request forgery|ssrf|blind ssrf)\b/i, "ssrf"],
    [/\b(path traversal|directory traversal|lfi|rfi|local file inclusion|arbitrary file (read|download))\b/i, "path-traversal"],
    [/\b(broken access control|idor|missing authorization|authori[sz]ation bypass|access control)\b/i, "access-control"],
    [/\b(exposed (secret|credential|password|api ?key)|hardcoded|secret (in|detected)|\.env|git repo|backup file)\b/i, "secrets"],
    [/\b(prompt injection|jailbreak|system prompt|model refusal|unsafe tool|excessive agency|llm|ai model)\b/i, "ai-security"],
    [/\b(missing|without|no) (security )?(header|headers)\b/i, "headers"],
    [/\b(cookie|httponly|secure flag|samesite|session)\b/i, "cookies"],
    [/\b(tls|ssl|certificate|https)\b/i, "tls"],
    [/\b(cors|cross[- ]origin)\b/i, "cors"],
    [/\b(directory listing|folder listing|index of\/)\b/i, "exposed-files"],
    [/\b(version disclosure|banner|stack trace|information disclosure|debug (mode|information))\b/i, "information-disclosure"],
    [/\b(misconfigur|outdated|deprecated|default (password|credential)|open (port|redis|elastic))\b/i, "configuration"],
];

/** Extract a CWE number from whatever shape the tool used ("CWE-79", "79", "cwe/79"). */
export function cweNumber(cwe: string | undefined): string | undefined {
    const m = /(?:cwe[-_/\s]?)?(\d{1,5})/i.exec(String(cwe ?? "").trim());
    if (!m) return undefined;
    const n = m[1]!;
    // Only treat it as a CWE when the source said so, or when the number is a real CWE id.
    return /^cwe/i.test(String(cwe ?? "").trim()) || Number(n) >= 100 ? n : undefined;
}

/** Where this finding belongs in the platform's vocabulary. Never a guess beyond what the tool said. */
export function categoryFor(f: { cwe?: string; scannerRuleId?: string; title?: string; description?: string }): FindingCategory {
    const byCwe = CWE_CATEGORY[cweNumber(f.cwe) ?? ""];
    if (byCwe) return byCwe;
    const hay = `${f.scannerRuleId ?? ""} ${f.title ?? ""}`;
    for (const [re, cat] of WORD_CATEGORY) if (re.test(hay)) return cat;
    const body = f.description ?? "";
    for (const [re, cat] of WORD_CATEGORY) if (re.test(body)) return cat;
    return "other";
}

/**
 * One stable key for "the same problem", so two tools reporting it on one address collapse into one finding.
 *
 * A shared identifier wins when there is one (a CVE id both tools cite), because that is the only case where two tools are provably
 * talking about the same thing. Otherwise the key names the tool and its rule, which keeps one tool's rule id from colliding with
 * another tool's unrelated rule of the same name.
 */
export function canonicalRule(scanner: ScannerId, scannerRuleId: string, cwe?: string): string {
    const cve = /\bCVE-\d{4}-\d{4,7}\b/i.exec(scannerRuleId);
    if (cve) return `cve:${cve[0].toUpperCase()}`;
    const n = cweNumber(cwe);
    if (n) return `${scanner}:cwe-${n}`;
    return `${scanner}:${scannerRuleId.toLowerCase()}`;
}

/** What a finding says about itself when the tool said nothing. Plain sentences, never a repeated title. */
const IMPACT_BY_CATEGORY: Record<string, string> = {
    injection: "An attacker who can control input to this address may be able to make the application read or change data it should not reach. What is possible depends on the component at fault and has to be judged by a person.",
    xss: "An attacker who can make a browser run the returned script may be able to act as that visitor in the site, which can mean reading pages they may see or acting as them.",
    ssrf: "An attacker who can control this address may be able to make the server fetch internal addresses and return their contents, which can reach internal services and stored data.",
    "path-traversal": "An attacker who can control this address may be able to read files outside the intended directory, which can include configuration and credentials.",
    "access-control": "An attacker may be able to reach data or operations that are not meant for them. The exact effect has to be judged by a person who knows the intended access rules.",
    secrets: "A credential or key published here may let its holder use the account or service it belongs to. Whether it is still valid has to be checked by its owner.",
    "ai-security": "An attacker may be able to steer the application away from what it should do. What that means in practice has to be judged by a person who knows what the application is for.",
    headers: "A browser will apply fewer protections to pages from this origin than the application's own team configured.",
    cookies: "A session cookie can be used where it should not be, which can let one visitor act as another.",
    tls: "Connections to this host can be read or altered in transit.",
    cors: "Another website's pages may be able to read answers from this one in a visitor's browser.",
    "exposed-files": "A file that should not be public can be downloaded by anyone who knows its address.",
    "information-disclosure": "The answer shows details about the application that make a later attack easier.",
    configuration: "The setting leaves the application weaker than its owners configured it to be.",
    other: "The scanner reported a problem here but did not describe what it would let an attacker do. A person has to judge this.",
};

const REMEDIATION_BY_CATEGORY: Record<string, string> = {
    injection: "Pass input to the component as data, not as code or as a query: use the library's parameterized or prepared statements, and never build a command or a template from a request.",
    xss: "Encode output for the context it is used in, and remove the script source: a content security policy limits the damage when something is missed.",
    ssrf: "Fetch only addresses from an allow-list, resolve names before connecting, and refuse loopback, private and metadata addresses.",
    "path-traversal": "Resolve the requested path and check it is inside the intended directory before reading it, instead of trusting the address.",
    "access-control": "Check on the server that the signed-in account is allowed to do this, on every path, not only in the user interface.",
    secrets: "Revoke the exposed credential, then store the new one where it is not published (an environment setting or a secret store).",
    "ai-security": "Keep instructions that must always apply outside the content the model reads, give the model the least authority it needs, and check its output before acting on it.",
    headers: "Send the platform's standard security response headers on every response.",
    cookies: "Mark session cookies Secure, HttpOnly and SameSite, and keep their lifetime short.",
    tls: "Use a currently supported TLS version and a certificate that is valid for the name and from a trusted issuer.",
    cors: "Answer only the origins that are meant to be allowed, and only with the methods and headers those origins need.",
    "exposed-files": "Remove the file from the published directory, or move it outside it, and check what it contained.",
    "information-disclosure": "Turn off the debug output and remove version details from answers given to visitors.",
    configuration: "Change the setting to the value the application's owners intended, and check it is not changed back by a deployment script.",
    other: "Follow the scanner's own reference for this rule, then have a person decide what it means for this application.",
};

export const impactFor = (category: FindingCategory): string => IMPACT_BY_CATEGORY[category] ?? IMPACT_BY_CATEGORY.other!;
export const remediationFor = (category: FindingCategory): string => REMEDIATION_BY_CATEGORY[category] ?? REMEDIATION_BY_CATEGORY.other!;

/** The problem and fix as one scanner finding's `CustomProblem`, ready for `normalize()` to store. */
export function scannerFindingToRaw(scanner: ScannerId, f: ScannerFinding, observedAt: string): RawResult {
    const category = (CATEGORIES as readonly string[]).includes(f.category) ? f.category : categoryFor(f);
    const custom: CustomProblem = {
        key: canonicalRule(scanner, f.scannerRuleId, f.cwe),
        title: f.title || f.scannerRuleId,
        category,
        severity: severityOf(f.severity),
        description: f.description || f.title,
        impact: f.impact?.trim() || impactFor(category),
        remediation: f.remediation?.trim() || remediationFor(category),
        scope: "path",
        confidence: f.confidence ?? "medium",
        scanner: { id: scanner, ruleId: f.scannerRuleId, reference: f.cwe ?? null },
    };
    const evidence = (f.evidence ?? []).slice(0, MAX_SCANNER_EVIDENCE).map((e) => `${e.label}: ${e.value}`).join("\n");
    const refs = (f.references ?? []).slice(0, 5).join(", ");
    const note = [`Reported by ${scanner}${f.cwe ? ` (${f.cwe})` : ""}${refs ? `. References: ${refs}` : ""}`, evidence ? `\n${evidence}` : ""].join("");
    return { check: "other", custom, url: f.url, observedAt: f.observedAt ?? observedAt, note: note.trim() };
}

const rank = (s: Severity): number => SEV_ORDER.indexOf(s);

/**
 * Collapse one run's findings: the same tool reporting the same rule on the same address once, keeping the most serious wording and
 * every piece of evidence it brought. Returns the kept findings and how many were folded together, so the run can say so.
 */
export function dedupeFindings(findings: readonly ScannerFinding[]): { findings: ScannerFinding[]; folded: number; dropped: number } {
    const byKey = new Map<string, ScannerFinding>();
    let folded = 0;
    const taken = findings.slice(0, MAX_SCANNER_FINDINGS);
    const dropped = findings.length - taken.length;
    for (const f of taken) {
        const key = `${f.scannerRuleId.toLowerCase()}|${f.url}`;
        const seen = byKey.get(key);
        if (!seen) {
            byKey.set(key, { ...f, evidence: [...(f.evidence ?? [])] });
            continue;
        }
        folded++;
        if (rank(f.severity) > rank(seen.severity)) Object.assign(seen, { ...f, evidence: [...seen.evidence, ...(f.evidence ?? [])] });
        else seen.evidence = [...seen.evidence, ...(f.evidence ?? [])];
        seen.evidence = seen.evidence.slice(0, MAX_SCANNER_EVIDENCE);
    }
    return { findings: [...byKey.values()], folded, dropped };
}

/** The most serious severity a run produced, for the one-line summary. */
export const worstSeverity = (findings: readonly ScannerFinding[]): Severity => findings.reduce<Severity>((worst, f) => (rank(f.severity) > rank(worst) ? f.severity : worst), "info");

export type { Confidence };
