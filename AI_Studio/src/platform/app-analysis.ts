/**
 * The application analysis: every source of knowledge about a project's application turned into one evidence-backed model version.
 *
 * Each source (the exploration's pages and traffic, the page text, the OpenAPI document, requirements, existing tests, uploaded schema
 * files, artefacts in imported repositories) becomes a fragment (engine/intel/fragment.ts). A source whose fingerprint has not changed
 * since it was last processed is not processed again: its last fragment, kept in the object store, is used. Fragments meet only in
 * merge.ts; decisions people made about rules are carried forward by fingerprint (carry-forward.ts); a version is stored only when the
 * merged model changed.
 *
 * Deterministic sources come first and need no AI. AI reads only text for rules and workflows, with the person's chosen key; without one
 * the structure is still built and one sentence says why rules are missing. A failed AI call fails only its own source, with its sentence,
 * and the last good fragment of that source stays in use. Every fragment is redacted before it is kept or merged, so no secret reaches the
 * stored model. Fragments live under the project's folder in the object store and go with their source and with the project.
 */
import path from "node:path";
import { carryForward } from "../engine/intel/carry-forward.js";
import { extractFromPages, pageDocument } from "../engine/intel/extract/from-pages.js";
import { extractFromTests } from "../engine/intel/extract/from-tests.js";
import { extractRules } from "../engine/intel/extract/rules.js";
import { ModelFragmentSchema, type ModelFragment } from "../engine/intel/fragment.js";
import { fragmentFromExploration } from "../engine/intel/from-exploration.js";
import { merge } from "../engine/intel/merge.js";
import { AppModelSchema, type AppVersion, type SourceKind } from "../engine/intel/model.js";
import { schemaFragment } from "../engine/intel/sources/db-schema.js";
import { existingTestDocuments, type StoredScript, type WrittenCase } from "../engine/intel/sources/existing-tests.js";
import { fingerprintCommit, fingerprintJson, fingerprintText } from "../engine/intel/sources/fingerprint.js";
import { openApiFragmentFromText } from "../engine/intel/sources/openapi.js";
import { findRepoArtefacts, type RepoArtefacts } from "../engine/intel/sources/repo.js";
import { parseRepoUrl } from "../engine/gitimport/url.js";
import type { Reach } from "../engine/identity/access.js";
import type { LlmClient } from "../engine/llm/provider.js";
import type { AppModel as UnderstandingModel } from "../engine/understanding/app-model.js";
import { HIDDEN, redactText } from "../shared/redact-text.js";
import { hideSecretLines, hideSecrets } from "../engine/intel/sources/hide-secrets.js";
import { AgentInputsStore } from "./agent-inputs-store.js";
import { envSecrets } from "./agent-routing.js";
import { EnvironmentStore } from "./environments-store.js";
import { IdentityStore } from "./identity-store.js";
import type { Credentials } from "./repo.js";
import { secretBoxOf } from "./ai-config.js";
import { randomUUID } from "node:crypto";
import { AppIntelStore, MAX_RULES_PER_PROJECT, type SourceRow } from "./app-intel-store.js";
import type { Platform } from "./bootstrap.js";
import { GitRepoStore } from "./custom-script-store.js";
import { GitSession } from "./git-checkout.js";
import { guardedFetch } from "./guarded-fetch.js";
import { HttpError } from "./http-error.js";
import { ManualCaseStore } from "./manual-case-store.js";
import { assertAllowedTarget } from "./net-guard.js";
import type { ObjectStore } from "./object-store.js";
import { RequirementStore } from "./requirement-store.js";
import { aiSkipReason, usageStoreFor } from "./usage-store.js";
import { JobMeter } from "../engine/llm/metered.js";
import { jobSentenceOf, personLlm } from "./ai-config.js";
import type { Sql } from "./sql.js";

/** Everything an analysis reads, gathered by the caller (gatherAnalysisInputs for a project; a test passes its own). */
export interface AnalysisInputs {
    exploration?: { ref: string; model: UnderstandingModel; reach?: Reach[]; roleDifferences?: string[] };
    openapi?: { ref: string; read: () => Promise<string> };
    requirements: Array<{ ref: string; title: string; description: string; acceptanceCriteria: string }>;
    tests: { cases: WrittenCase[]; scripts: StoredScript[] };
    /** Imported repositories at their commit; `read` checks the repository out and finds its artefacts (sources/repo.ts). */
    repositories: Array<{ ref: string; commit: string; read: () => Promise<RepoArtefacts> }>;
    /** Which build this is, when a deploy said so; never inferred. */
    appVersion?: AppVersion;
    /** The project's saved secrets (sign-in passwords, tokens, authenticator secrets): hidden wherever they appear in any source. */
    secrets?: string[];
}

export interface AnalysisResult {
    changed: boolean;
    /** The new version's number; null when nothing changed. */
    version: number | null;
    /** `kind ref` of each source processed in this run. */
    processed: string[];
    failed: Array<{ kind: SourceKind; ref: string; error: string }>;
    rules: { carried: number; added: number; evidenceGone: number; leftOut: number };
}

/** Lines of a repository document longer than this are cut before redaction (redaction time grows with line length). */
const MAX_DOC_LINE = 1000;
const MAX_DOC_LINES = 5000;
const REQUIREMENTS_REF = "Requirements";
export const ANALYSIS_STOPPED = "The reading was stopped before it finished. Nothing of it was kept.";
export const ANALYSIS_OVER_TIME = "The time limit was reached while the application understanding was being updated, so that update stopped and nothing of it was kept. The exploration finished in time and its results stand.";
export const ANALYSIS_RUNNING = "The application is already being read. Wait for it to finish, or stop it first.";
export const MAX_SCHEMA_FILES = 20;
const TESTS_REF = "Existing tests";
export const pagesRefOf = (explorationRef: string): string => `${explorationRef} (page text)`.slice(0, 500);

export const fragmentKey = (projectId: string, sourceId: string): string => path.posix.join(projectId, "intel", "fragments", `${sourceId}.json`);
export const schemaKey = (projectId: string, sourceId: string): string => path.posix.join(projectId, "intel", "schemas", `${sourceId}.txt`);
const repoIndexKey = (projectId: string, sourceId: string): string => path.posix.join(projectId, "intel", "repos", `${sourceId}.json`);

const KEPT_AS_IS = new Set(["fingerprint", "processedAt", "analysedAt", "at"]);
/** Names, addresses and references: the project's secrets and the shared redaction only (the password-shape rule would eat `file.md@c1#L2`). */
const REFERENCES = new Set(["id", "ref", "sourceRef", "path", "from", "to", "page", "entity", "endpoint", "endpoints", "entities", "workflows", "reaches", "screenId", "method", "requestSchema", "responseSchema", "status", "kind", "origin", "sourceType", "explicitness", "type", "in"]);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A workflow id this analysis generates (an exploration's journey, a workflow read from a document): its own secrets are hidden, but the
 * secret-shape rule is not applied, because a long journey id looks like a token and hiding it would fold every such journey into one.
 * The journey's name went through secret hiding before its id was made from it (from-exploration.ts).
 */
const GENERATED_ID = /^(?:journey-\d+-[a-z0-9-]*|wf-[0-9a-f]{16})$/;
const ID_KEYS = new Set(["id", "workflows"]);
const slugOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Every text in a fragment through secret hiding before it is kept or merged: the project's own secrets everywhere, then, for prose (page
 * purposes, labels, messages, options, descriptions), the secret-shaped values of hideSecrets; for references, the shared redaction.
 * Fingerprints and times are not text. Valid again or refused.
 */
export function redactFragment(f: ModelFragment, secrets: readonly string[] = []): ModelFragment {
    const own = secrets.filter((x) => x && x.length >= 4).map((x) => new RegExp(escapeRe(x), "g"));
    // A generated id is a slug of a name: the project's secrets as they appear in a slug.
    const ownSlugs = secrets.map((x) => slugOf(x ?? "")).filter((x) => x.length >= 4);
    const walk = (v: unknown, key: string): unknown => {
        if (typeof v === "string") {
            if (KEPT_AS_IS.has(key)) return v;
            if (ID_KEYS.has(key) && GENERATED_ID.test(v)) return ownSlugs.reduce((t, x) => t.split(x).join("hidden"), v);
            const max = Math.max(v.length, 1000);
            if (REFERENCES.has(key)) return redactText(own.reduce((t, re) => t.replace(re, HIDDEN), v), max);
            return hideSecrets(v, { secrets, max });
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, key));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
        return v;
    };
    return ModelFragmentSchema.parse(walk(f, ""));
}

/** One repository document as numbered-line text: cut, then every line through secret hiding. */
const docLines = (text: string, secrets: readonly string[]): string[] =>
    hideSecretLines(
        text
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .slice(0, MAX_DOC_LINES)
            .map((l) => l.slice(0, MAX_DOC_LINE * 2)),
        { secrets, max: MAX_DOC_LINE },
    );

const keyOf = (kind: SourceKind, ref: string) => `${kind}\n${ref}`;
const emptyModel = () => AppModelSchema.parse({});

interface Unit {
    kind: SourceKind;
    ref: string;
    /** Fingerprint of what is there now; compared with the stored one. */
    fingerprint: string;
    ai: boolean;
    process: () => Promise<ModelFragment>;
    /** Combines a fresh fragment with what the last one knew (only the page text uses it: unchanged pages are not sent again). */
    combine?: (fresh: ModelFragment, previous: ModelFragment | undefined) => ModelFragment;
    /** A fragment kept from before under another ref (a repository artefact whose text did not change at a new commit). */
    carried?: ModelFragment;
}

interface IndexEntry {
    kind: SourceKind;
    ref: string;
    path: string;
    text: string;
}

export class AppAnalysis {
    private readonly intel: AppIntelStore;
    private readonly now: () => string;

    constructor(private readonly d: { sql: Sql; store: ObjectStore; now?: () => string }) {
        this.now = d.now ?? (() => new Date().toISOString());
        this.intel = new AppIntelStore(d.sql, this.now);
    }

    private async readFragment(projectId: string, id: string): Promise<ModelFragment | undefined> {
        try {
            return ModelFragmentSchema.parse(JSON.parse((await this.d.store.getBytes(fragmentKey(projectId, id))).toString("utf8")));
        } catch {
            return undefined; // missing or unreadable: the source is processed again
        }
    }

    private async readIndex(projectId: string, id: string): Promise<IndexEntry[] | undefined> {
        try {
            return JSON.parse((await this.d.store.getBytes(repoIndexKey(projectId, id))).toString("utf8")) as IndexEntry[];
        } catch {
            return undefined;
        }
    }

    /** Connects an uploaded schema file (a new one, or a new text for the same name): the next analysis reads it. */
    async uploadSchema(projectId: string, name: string, text: string): Promise<SourceRow> {
        const existing = (await this.intel.sources(projectId)).find((s) => s.kind === "db_schema" && s.ref === name);
        const uploads = (await this.intel.sources(projectId)).filter((s) => s.kind === "db_schema").length;
        if (!existing && uploads >= MAX_SCHEMA_FILES) throw new HttpError(409, `A project can have at most ${MAX_SCHEMA_FILES} schema files. Remove one first.`);
        const row = await this.intel.upsertSource(projectId, { kind: "db_schema", ref: name, status: "connected" });
        await this.d.store.put(schemaKey(projectId, row.id), text, { contentType: "text/plain; charset=utf-8" });
        return row;
    }

    /** Removes a source and what is kept for it (its fragment, its repository index, an uploaded schema file). */
    async deleteSource(projectId: string, sourceId: string): Promise<boolean> {
        const gone = await this.intel.deleteSource(projectId, sourceId);
        if (gone) for (const key of [fragmentKey(projectId, sourceId), repoIndexKey(projectId, sourceId), schemaKey(projectId, sourceId)]) await this.d.store.delete(key).catch(() => false);
        return gone;
    }

    /**
     * Runs one analysis for a project. `llm` reads text for rules; without it `noAi` is the sentence saying why (the person's key problem).
     * Throws only for a fault of the platform itself (database, object store); a source that cannot be read fails with its sentence.
     */
    async run(projectId: string, inputs: AnalysisInputs, o: { llm?: LlmClient; noAi?: string; signal?: AbortSignal; createdBy?: string | null } = {}): Promise<AnalysisResult> {
        const now = this.now();
        const secrets = [...new Set(inputs.secrets ?? [])];
        const rows = await this.intel.sources(projectId);
        const rowOf = new Map(rows.map((r) => [keyOf(r.kind, r.ref), r]));
        const previous = new Map<string, ModelFragment>();
        for (const r of rows) {
            const f = await this.readFragment(projectId, r.id);
            if (f) previous.set(keyOf(r.kind, r.ref), f);
        }
        const deterministic: Unit[] = [];
        const ai: Array<(known: { id: string; name: string }[]) => Unit> = [];
        const unchangedRepos: Array<{ row: SourceRow; fragment: ModelFragment; entries: IndexEntry[] }> = [];
        const repoIndexes: Array<{ ref: string; entries: IndexEntry[] }> = [];
        const repoFailures = new Map<string, string>();
        const kept = new Set<string>();

        // The exploration: pages, traffic, journeys, roles (no AI) and the page text (AI).
        let oldRunner = false;
        if (inputs.exploration) {
            const e = inputs.exploration;
            const crawl = redactFragment(fragmentFromExploration({ model: e.model, ref: e.ref, now, reach: e.reach, roleDifferences: e.roleDifferences }), secrets);
            oldRunner = e.model.pages.length > 0 && e.model.pages.some((p) => p.discovery !== 2);
            deterministic.push({ kind: "exploration", ref: crawl.source.ref, fingerprint: crawl.source.fingerprint, ai: false, process: async () => crawl });
            const pages = crawl.model.pages;
            const docs = new Map(pages.map((p) => [p.path, fingerprintJson(pageDocument(p))]));
            const before = previous.get(keyOf("exploration", crawl.source.ref));
            const unchanged = new Set(before ? before.model.pages.filter((p) => docs.get(p.path) === fingerprintJson(pageDocument(p))).map((p) => p.path) : []);
            const ref = pagesRefOf(e.ref);
            ai.push((known) => ({
                kind: "exploration",
                ref,
                fingerprint: fingerprintJson([...docs].sort()),
                ai: true,
                process: () => extractFromPages(o.llm!, pages, { unchanged, knownWorkflows: known, ref, now, signal: o.signal }),
                combine: (fresh, last) => (last ? keepUnchangedPages(fresh, last, unchanged) : fresh),
            }));
        }

        if (inputs.openapi) {
            const a = inputs.openapi;
            let text: string | undefined;
            let error: string | undefined;
            try {
                text = await a.read();
            } catch (e) {
                error = `The API description could not be fetched: ${redactText(e instanceof Error ? e.message : String(e), 200)}`;
            }
            deterministic.push({
                kind: "openapi",
                ref: a.ref.slice(0, 500),
                fingerprint: text === undefined ? "" : fingerprintText(text),
                ai: false,
                process: async () => (text === undefined ? failedFragment("openapi", a.ref, error!, now) : openApiFragmentFromText(text, { ref: a.ref, now })),
            });
        }

        // Uploaded schema files: rows whose file is in the object store.
        for (const r of rows.filter((x) => x.kind === "db_schema")) {
            let text: string;
            try {
                text = (await this.d.store.getBytes(schemaKey(projectId, r.id))).toString("utf8");
            } catch {
                continue; // a schema artefact of a repository, not an upload
            }
            kept.add(keyOf(r.kind, r.ref));
            deterministic.push({ kind: "db_schema", ref: r.ref, fingerprint: fingerprintText(text), ai: false, process: async () => schemaFragment(text, { ref: r.ref, now }) });
        }

        // Repositories: one source each (fingerprint of the commit), and one per artefact found in it.
        for (const repo of inputs.repositories) {
            if (o.signal?.aborted) throw new Error(ANALYSIS_STOPPED);
            const ref = repo.ref.slice(0, 500);
            const fp = fingerprintCommit(repo.commit);
            const row = rowOf.get(keyOf("repository", ref));
            const index = row ? await this.readIndex(projectId, row.id) : undefined;
            const last = previous.get(keyOf("repository", ref));
            if (row && row.fingerprint === fp && row.status === "processed" && index && last && index.every((x) => previous.has(keyOf(x.kind, x.ref)))) {
                unchangedRepos.push({ row, fragment: last, entries: index });
                continue;
            }
            let found: RepoArtefacts;
            try {
                found = await untilStopped(repo.read(), o.signal);
            } catch (e) {
                if (o.signal?.aborted) throw new Error(ANALYSIS_STOPPED);
                const error = `The repository could not be read at ${repo.commit.slice(0, 12)}: ${redactText(e instanceof Error ? e.message : String(e), 200)}`;
                repoFailures.set(ref, error);
                // What was read from it before stays in use.
                if (index) for (const x of index) kept.add(keyOf(x.kind, x.ref));
                deterministic.push({ kind: "repository", ref, fingerprint: "", ai: false, process: async () => ({ ...(last ?? failedFragment("repository", ref, error, now)), source: { kind: "repository", ref, fingerprint: row?.fingerprint ?? "", status: "failed", error, processedAt: now } }) });
                continue;
            }
            const entries: IndexEntry[] = [];
            const notes = [...found.notes, ...(found.skipped.length ? [`${found.skipped.length} file${found.skipped.length === 1 ? " was" : "s were"} not read (links, binary, too large or outside the repository).`] : [])];
            deterministic.push({
                kind: "repository",
                ref,
                fingerprint: fp,
                ai: false,
                process: async () => ({ source: { kind: "repository", ref, fingerprint: fp, status: "processed", processedAt: now }, model: emptyModel(), rules: [], notes: notes.slice(0, 50).map((n) => n.slice(0, 500)) }),
            });
            for (const a of found.artefacts) {
                const textFp = fingerprintText(a.text);
                entries.push({ kind: a.kind, ref: a.ref, path: a.path, text: textFp });
                const old = index?.find((x) => x.kind === a.kind && x.path === a.path && x.text === textFp);
                const carried = old ? previous.get(keyOf(old.kind, old.ref)) : undefined;
                const reuse = carried && old ? retarget(carried, old.ref, a.ref) : undefined;
                if (a.kind === "openapi" || a.kind === "db_schema") {
                    deterministic.push({ kind: a.kind, ref: a.ref, fingerprint: textFp, ai: false, carried: reuse, process: async () => (a.kind === "openapi" ? openApiFragmentFromText(a.text, { ref: a.ref, now }) : schemaFragment(a.text, { ref: a.ref, now })) });
                } else {
                    const lines = docLines(a.text, secrets);
                    const sourceType = a.kind === "existing_tests" ? ("existing_test" as const) : ("requirement" as const);
                    ai.push((known) => ({
                        kind: a.kind,
                        ref: a.ref,
                        fingerprint: textFp,
                        ai: true,
                        carried: reuse,
                        process: () => extractRules(o.llm!, { source: { kind: a.kind, ref: a.ref }, sourceType, documents: [{ ref: a.ref, lines }], knownWorkflows: known, secrets, now, signal: o.signal }),
                    }));
                }
            }
            repoIndexes.push({ ref, entries });
        }

        if (inputs.requirements.length) {
            const documents = inputs.requirements.map((r) => ({
                ref: r.ref,
                lines: [`${r.ref}: ${r.title}`, ...r.description.split(/\r?\n/), ...(r.acceptanceCriteria.trim() ? ["Acceptance criteria:", ...r.acceptanceCriteria.split(/\r?\n/)] : [])].filter((l) => l.trim()),
            }));
            ai.push((known) => ({
                kind: "requirements",
                ref: REQUIREMENTS_REF,
                fingerprint: fingerprintJson(documents),
                ai: true,
                process: () => extractRules(o.llm!, { source: { kind: "requirements", ref: REQUIREMENTS_REF }, sourceType: "requirement", documents, knownWorkflows: known, secrets, now, signal: o.signal }),
            }));
        }

        const tests = existingTestDocuments({ ...inputs.tests, secrets });
        if (tests.documents.length) {
            ai.push((known) => ({
                kind: "existing_tests",
                ref: TESTS_REF,
                fingerprint: fingerprintJson(tests.documents),
                ai: true,
                process: async () => {
                    const f = await extractFromTests(o.llm!, tests.documents, { ref: TESTS_REF, knownWorkflows: known, now, signal: o.signal });
                    return { ...f, notes: [...f.notes, ...tests.notes].slice(0, 50) };
                },
            }));
        }

        // Process: deterministic sources first; the workflows they found are offered to the AI reading so its rules can link to them.
        const fragments: ModelFragment[] = [];
        const processed: Array<{ unit: Unit; fragment: ModelFragment }> = [];
        const failed: AnalysisResult["failed"] = [];
        const settle = async (u: Unit): Promise<ModelFragment> => {
            const k = keyOf(u.kind, u.ref);
            kept.add(k);
            const row = rowOf.get(k);
            const last = previous.get(k);
            if (row && last && row.status === "processed" && row.fingerprint === u.fingerprint && u.fingerprint) return last;
            if (u.carried) {
                processed.push({ unit: u, fragment: u.carried });
                return u.carried;
            }
            if (u.ai && !o.llm) {
                const sentence = `Rules were not read from documents, tests or pages: ${o.noAi ?? "no AI key is available."}`;
                if (last) return { ...last, notes: [...new Set([...last.notes, sentence])].slice(0, 50) };
                const stub: ModelFragment = { source: { kind: u.kind, ref: u.ref, fingerprint: "", status: "connected" }, model: emptyModel(), rules: [], notes: [sentence] };
                if (!row) processed.push({ unit: u, fragment: stub });
                return stub;
            }
            let fresh = redactFragment(await u.process(), secrets);
            if (fresh.source.status === "failed") {
                const error = fresh.source.error ?? "It could not be read.";
                failed.push({ kind: u.kind, ref: u.ref, error });
                const stays = last ? { ...last, source: { ...last.source, status: "failed" as const, error } } : fresh;
                processed.push({ unit: u, fragment: stays });
                return stays;
            }
            if (u.combine) fresh = u.combine(fresh, last);
            fresh = { ...fresh, source: { ...fresh.source, kind: u.kind, ref: u.ref, fingerprint: u.fingerprint } };
            processed.push({ unit: u, fragment: fresh });
            return fresh;
        };
        for (const u of deterministic) fragments.push(await settle(u));
        for (const r of unchangedRepos) {
            kept.add(keyOf("repository", r.row.ref));
            fragments.push(r.fragment);
            for (const x of r.entries) {
                kept.add(keyOf(x.kind, x.ref));
                fragments.push(previous.get(keyOf(x.kind, x.ref))!);
            }
        }
        const known = [...new Map(fragments.flatMap((f) => f.model.workflows).map((w) => [w.id, { id: w.id, name: w.name }])).values()].slice(0, 200);
        for (const make of ai) fragments.push(await settle(make(known)));

        // Repository artefacts not found this time (another commit, a deleted file) and sources no longer connected go.
        const gone = rows.filter((r) => !kept.has(keyOf(r.kind, r.ref)));

        // Stopped (cancelled or over the time limit) while reading: nothing of this run is stored.
        if (o.signal?.aborted) throw new Error(ANALYSIS_STOPPED);
        const latest = await this.intel.latest(projectId);
        const merged = merge(latest?.model, fragments, { oldRunner });
        const result: AnalysisResult = { changed: merged.changed, version: null, processed: processed.map((p) => `${p.unit.kind} ${p.unit.ref}`), failed, rules: { carried: 0, added: 0, evidenceGone: 0, leftOut: 0 } };
        if (!merged.changed && !gone.length && !processed.length) return result;

        // Fragments and indexes first: a crash after this re-processes the source next time (its row still has the old fingerprint).
        const ids = new Map<string, string>();
        for (const p of processed) {
            const row = rowOf.get(keyOf(p.unit.kind, p.unit.ref)) ?? (await this.intel.upsertSource(projectId, { kind: p.unit.kind, ref: p.unit.ref, status: "connected" }));
            ids.set(keyOf(p.unit.kind, p.unit.ref), row.id);
            if (p.fragment.source.status !== "connected") await this.d.store.put(fragmentKey(projectId, row.id), JSON.stringify(p.fragment), { contentType: "application/json" });
        }
        for (const r of repoIndexes) {
            const id = ids.get(keyOf("repository", r.ref)) ?? (await this.intel.upsertSource(projectId, { kind: "repository", ref: r.ref, status: "connected" })).id;
            await this.d.store.put(repoIndexKey(projectId, id), JSON.stringify(r.entries), { contentType: "application/json" });
        }

        let versionId = latest?.id ?? null;
        let leftOut = 0;
        if (merged.changed || gone.length) {
            const version = (latest?.version ?? 0) + 1;
            const commits = inputs.repositories.filter((r) => !repoFailures.has(r.ref.slice(0, 500))).map((r) => r.commit.slice(0, 40));
            const appVersion: AppVersion = inputs.appVersion ?? (commits.length ? { source: "repository", label: commits.join(", ").slice(0, 200), analysedAt: now } : { source: "unversioned", label: "", analysedAt: now });
            const before = await this.intel.rules(projectId);
            const carried = carryForward(before, merged.rules, { version, at: now });
            const room = Math.max(0, MAX_RULES_PER_PROJECT - before.length);
            leftOut = Math.max(0, carried.rules.filter((r) => !r.id).length - room);
            const model = { ...merged.model, appVersion };
            if (leftOut) model.missingContext = [...model.missingContext.slice(0, 99), { text: `${leftOut} new rules were not kept: a project holds at most ${MAX_RULES_PER_PROJECT} rules.` }];
            const fingerprints: Record<string, string> = {};
            for (const f of fragments) fingerprints[`${f.source.kind}:${f.source.ref}`] = f.source.fingerprint;
            // The version and its rules are stored together: a fault leaves neither, and the next analysis stores both.
            const { v, saved } = await this.d.sql.tx(async (tx) => {
                const v = await this.intel.addVersion({ projectId, model, appVersion, sourceFingerprints: fingerprints, note: `${result.processed.length} source${result.processed.length === 1 ? "" : "s"} read`, createdBy: o.createdBy ?? null, tx });
                return { v, saved: await this.intel.saveCarried(projectId, carried.rules, { modelVersionId: v.id, tx }) };
            });
            versionId = v.id;
            result.changed = true;
            result.version = v.version;
            result.rules = { ...carried.summary, leftOut: leftOut + saved.leftOut };
        }
        for (const p of processed) {
            const s = p.fragment.source;
            if (s.status === "connected") continue;
            await this.intel.upsertSource(projectId, {
                kind: p.unit.kind,
                ref: p.unit.ref,
                status: s.status,
                ...(s.status === "processed" ? { fingerprint: p.unit.fingerprint, modelVersionId: versionId } : { error: s.error ?? "It could not be read." }),
            });
        }
        for (const r of gone) await this.deleteSource(projectId, r.id);
        return result;
    }
}

/** The work's result, or ANALYSIS_STOPPED as soon as `signal` aborts (a repository read does not hold up a stop). */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work;
    work.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(new Error(ANALYSIS_STOPPED));
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
}

function failedFragment(kind: SourceKind, ref: string, error: string, now: string): ModelFragment {
    return { source: { kind, ref: ref.slice(0, 500), fingerprint: "", status: "failed", error: error.slice(0, 500), processedAt: now }, model: emptyModel(), rules: [], notes: [] };
}

/** A fragment kept from an artefact at an older commit, now under its ref at the new commit (its evidence names the new ref too). */
function retarget(f: ModelFragment, from: string, to: string): ModelFragment {
    return ModelFragmentSchema.parse(JSON.parse(JSON.stringify(f).split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))));
}

/**
 * The page text fragment of this run has only the pages that changed. What the last one found on the pages that did not change is kept:
 * its rules, workflows, roles and transitions whose evidence is all on those pages.
 */
function keepUnchangedPages(fresh: ModelFragment, last: ModelFragment, unchanged: ReadonlySet<string>): ModelFragment {
    if (!unchanged.size) return fresh;
    const onUnchanged = (refs: string[]) => refs.length > 0 && refs.every((r) => r.startsWith("page:") && unchanged.has(r.slice(5).split("#")[0]!));
    const rules = [...fresh.rules, ...last.rules.filter((r) => onUnchanged([r.sourceRef, ...r.evidence.map((e) => e.ref)]))];
    const model = {
        ...fresh.model,
        workflows: [...fresh.model.workflows, ...last.model.workflows.filter((w) => onUnchanged(w.evidence.map((e) => e.ref)) && !fresh.model.workflows.some((x) => x.id === w.id))],
        roles: [...fresh.model.roles, ...last.model.roles.filter((r) => onUnchanged(r.evidence.map((e) => e.ref)) && !fresh.model.roles.some((x) => x.name === r.name))],
        transitions: [...fresh.model.transitions, ...last.model.transitions.filter((t) => onUnchanged(t.evidence.map((e) => e.ref)))],
    };
    return ModelFragmentSchema.parse({ ...fresh, model, rules: rules.slice(0, 2000), notes: fresh.notes });
}

/** Test script origins that mean a person wrote it: typed by hand, recorded, or imported from their own files. */
export const PERSON_ORIGINS: ReadonlySet<string> = new Set(["manual", "recorded", "imported"]);

/** Largest OpenAPI document fetched for an analysis, and how long the fetch may take. */
export const OPENAPI_LIMITS = { bytes: 2 * 1024 * 1024, timeoutMs: 30_000 };

/** The project's OpenAPI document through the guarded fetch (no redirects, public addresses only when the install blocks private ones). */
export async function fetchOpenApiText(url: string, fetchImpl: typeof fetch = guardedFetch, signal?: AbortSignal): Promise<string> {
    const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OPENAPI_LIMITS.timeoutMs)]) : AbortSignal.timeout(OPENAPI_LIMITS.timeoutMs), headers: { accept: "application/json, application/yaml, text/yaml, */*" } });
    if (!res.ok) throw new Error(`the address answered ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > OPENAPI_LIMITS.bytes) throw new Error(`the document is larger than ${OPENAPI_LIMITS.bytes / 1024 / 1024} MB.`);
    // Read in pieces and stop at the cap: a server that sends no length cannot fill the memory.
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > OPENAPI_LIMITS.bytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`the document is larger than ${OPENAPI_LIMITS.bytes / 1024 / 1024} MB.`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Every secret the project has saved, in the forms a text may quote it: the application's and the saved agent inputs' sign-in, the test
 * accounts, and each environment's secrets. Unreadable ones (the encryption key changed) count as none.
 */
export function projectSecrets(p: Pick<Platform, "db" | "repo" | "config">, projectId: string, applicationId?: string, saved?: Credentials): string[] {
    const out: string[] = [];
    const add = (c: (Credentials & { apiToken?: string; apiAuthHeader?: string; oauth2?: { clientSecret?: string } }) | undefined, roles: Array<{ username?: string; password?: string; totpSecret?: string; apiToken?: string }> = []) => {
        out.push(...envSecrets({ credentials: c?.password ? { username: c.username ?? "", password: c.password, totpSecret: c.totpSecret } : undefined, roles: roles as never, apiToken: c?.apiToken, apiAuthHeader: c?.apiAuthHeader }));
        for (const x of [c?.totpSecret, c?.oauth2?.clientSecret]) if (x && x.length >= 4) out.push(x);
    };
    const box = secretBoxOf(p.config);
    const quietly = (fn: () => void) => {
        try {
            fn();
        } catch {
            /* unreadable: none */
        }
    };
    quietly(() => add(applicationId ? (p.repo.getApplication(applicationId)?.credentials as never) : undefined));
    quietly(() => add(applicationId ? (p.repo.applicationRowCredentials(applicationId) as never) : undefined)); // the row's own, also when Settings replaced it
    quietly(() => add(saved as never));
    quietly(() => add(undefined, new IdentityStore(p.db, box).get(projectId)));
    quietly(() => {
        const envs = new EnvironmentStore(p.db, box);
        for (const e of envs.list(projectId)) {
            const s = envs.secretsOf(e);
            add({ username: s.username ?? "", password: s.password ?? "", totpSecret: s.totpSecret, apiToken: s.apiToken, apiAuthHeader: s.apiAuthHeader } as never);
        }
    });
    return [...new Set(out)].filter((x) => x.length >= 4);
}

/**
 * What a project has to analyse: the latest exploration's understanding model, the saved OpenAPI address, active requirements, written
 * test cases and readable test scripts, and imported repositories at their last imported commit (read without credentials, so a private
 * repository fails with its sentence). Nothing is read from the application itself here except the OpenAPI document.
 */
export async function gatherAnalysisInputs(p: Pick<Platform, "db" | "sql" | "repo" | "config">, projectId: string, o: { fetchText?: (url: string, signal?: AbortSignal) => Promise<string>; git?: GitSession; signal?: AbortSignal } = {}): Promise<AnalysisInputs> {
    const app = p.repo.getLatestApplicationPublic(projectId);
    const model = p.repo.getLatestAppModel(projectId);
    const saved = new AgentInputsStore(p.db, secretBoxOf(p.config)).get(projectId);
    const requirements = (await new RequirementStore(p.sql).list(projectId)).filter((r) => r.status !== "retired");
    // Only tests a person wrote, recorded or imported state what is expected. What the AI or an exploration wrote reflects what the
    // application did (or a guess), so it is not read at all: reading it would feed generated tests back as stated behaviour.
    const generatedCases = new Set(p.db.all<{ id: string }>("SELECT manual_case_id AS id FROM requirement_links WHERE project_id = ? AND origin = 'generated' AND manual_case_id IS NOT NULL", projectId).map((r) => r.id));
    const cases = new ManualCaseStore(p.db).listCases(projectId).filter((c) => !generatedCases.has(c.id));
    // The AI's scripts are recognised by authorship, not by their origin field (an AI script for a written case is saved as imported or
    // manual): a test any version of which the AI wrote, or one a generation job made, is not a person's.
    const aiWritten = new Set(p.db.all<{ id: string }>("SELECT DISTINCT test_case_id AS id FROM test_versions WHERE project_id = ? AND source = 'ai'", projectId).map((r) => r.id));
    const scripts = p.repo.listTests(projectId).filter((t) => !t.unreadable && t.spec.steps.length > 0 && PERSON_ORIGINS.has(t.spec.source?.origin ?? "manual") && !t.jobId && !aiWritten.has(t.id));
    const repos = new GitRepoStore(p.db).list(projectId).filter((r) => r.url && r.commit);
    const secrets = projectSecrets(p, projectId, app?.id ? String(app.id) : undefined, saved?.credentials);
    const git = o.git ?? (repos.length ? new GitSession({ scratchRoot: path.join(p.config.scratchDir, "intel-repos") }) : undefined);
    return {
        ...(model && app ? { exploration: { ref: String(app.url ?? model.url).slice(0, 500), model } } : {}),
        ...(saved?.openApiUrl ? { openapi: { ref: saved.openApiUrl, read: () => (o.fetchText ? o.fetchText(saved.openApiUrl!, o.signal) : fetchOpenApiText(saved.openApiUrl!, guardedFetch, o.signal)) } } : {}),
        requirements: requirements.map((r) => ({ ref: r.ref, title: r.title, description: r.description, acceptanceCriteria: r.acceptanceCriteria })),
        tests: {
            cases: cases.map((c) => ({ ref: c.ref, title: c.title, area: c.area || undefined, requirement: c.requirement || undefined, steps: c.steps.map((x) => ({ action: x.action, expected: x.expected || undefined })) })),
            scripts: scripts.map((t) => ({ key: t.testKey, spec: t.spec })),
        },
        secrets,
        repositories: repos.map((r) => ({
            ref: r.url!,
            commit: r.commit,
            read: async () => {
                const address = parseRepoUrl(r.url!);
                if (address.transport === "https") await assertAllowedTarget(address.cloneUrl);
                return git!.withCheckout(address, { ref: r.commit, isCommit: true }, undefined, (c) => findRepoArtefacts(c, { subpath: r.subpath }));
            },
        })),
    };
}

/**
 * Analyses started from the API run in the background, one per project at a time, in this process (the API runs as one process). Their
 * state lives here only: a restart ends a running one, and since a source is only ever connected, processed or failed in the database,
 * nothing is left looking "running"; the next analysis redoes what was not stored.
 */
interface Running {
    since: string;
    abort: AbortController;
    done: Promise<AnalysisResult | undefined>;
}
export interface LastAnalysis {
    at: string;
    changed: boolean;
    version: number | null;
    failed: number;
    error?: string;
}
const running = new WeakMap<object, Map<string, Running>>();
const finished = new WeakMap<object, Map<string, LastAnalysis>>();
const of = <T>(m: WeakMap<object, Map<string, T>>, db: object) => m.get(db) ?? (m.set(db, new Map()), m.get(db)!);

export function analysisState(db: object, projectId: string): { running: { since: string } | null; last: LastAnalysis | null } {
    const r = of(running, db).get(projectId);
    return { running: r ? { since: r.since } : null, last: of(finished, db).get(projectId) ?? null };
}

/** Stops the project's running analysis; false when none runs. */
export function stopAnalysis(db: object, projectId: string): boolean {
    const r = of(running, db).get(projectId);
    if (!r) return false;
    r.abort.abort();
    return true;
}

/** Runs `work` as the project's one analysis: 409 while another runs; stopped by stopAnalysis or after `maxMinutes`. */
function track(db: object, projectId: string, maxMinutes: number, work: (signal: AbortSignal) => Promise<AnalysisResult>, now: () => string): { since: string; done: Promise<AnalysisResult | undefined> } {
    const tasks = of(running, db);
    if (tasks.has(projectId)) throw new HttpError(409, ANALYSIS_RUNNING);
    const abort = new AbortController();
    const timer = maxMinutes > 0 ? setTimeout(() => abort.abort(), maxMinutes * 60_000) : undefined;
    timer?.unref?.();
    const since = now();
    const done = (async () => {
        try {
            const r = await work(abort.signal);
            of(finished, db).set(projectId, { at: now(), changed: r.changed, version: r.version, failed: r.failed.length });
            return r;
        } catch (e) {
            const error = abort.signal.aborted ? ANALYSIS_STOPPED : `The reading could not finish: ${redactText(e instanceof Error ? e.message : String(e), 300)}`;
            of(finished, db).set(projectId, { at: now(), changed: false, version: null, failed: 0, error });
            return undefined;
        } finally {
            clearTimeout(timer);
            tasks.delete(projectId);
        }
    })();
    tasks.set(projectId, { since, abort, done });
    return { since, done };
}

/**
 * Starts an analysis for a person (POST …/intel/analyse). It uses that person's chosen AI key exactly like other AI work (ai-config.ts, no
 * other key instead) and counts its AI use against the budgets under an id of its own; without a usable key, or past the AI token limit, it
 * still builds the structure and says why rules were not read.
 */
export async function startAnalysis(p: Pick<Platform, "db" | "sql" | "repo" | "config" | "store">, projectId: string, ownerId: string | null, o: { now?: () => string; fetchText?: (url: string, signal?: AbortSignal) => Promise<string> } = {}): Promise<{ since: string; done: Promise<AnalysisResult | undefined> }> {
    const now = o.now ?? (() => new Date().toISOString());
    if (of(running, p.db).has(projectId)) throw new HttpError(409, ANALYSIS_RUNNING);
    const { llm, billing, blocked } = await personLlm({ sql: p.sql, config: p.config }, ownerId);
    const usage = usageStoreFor(p.db, p.config);
    const skip = aiSkipReason(usage, projectId);
    const usable = llm.modelName !== "unavailable" && !blocked && !skip;
    const noAi = skip ?? (blocked ? jobSentenceOf(blocked) : "no AI model is set up for this work.");
    return track(
        p.db,
        projectId,
        p.config.JOB_MAX_MINUTES ?? 120,
        async (signal) => {
            const meter = usable ? new JobMeter({ backend: usage, jobId: `analysis-${randomUUID()}`, projectId, billing }) : undefined;
            try {
                const inputs = await gatherAnalysisInputs(p, projectId, { signal, fetchText: o.fetchText });
                return await new AppAnalysis({ sql: p.sql, store: p.store, now }).run(projectId, inputs, { ...(meter ? { llm: meter.wrap(llm) } : { noAi }), signal, createdBy: ownerId });
            } finally {
                meter?.finish();
            }
        },
        now,
    );
}

/**
 * The analysis an exploration job runs after it saved its model, under the job's own lease, cancel signal and time limit, with the job's
 * model client (the starter's key, already metered). A manual analysis of the same project still running is stopped first. Its failure
 * never fails the exploration: the caller reports it as a warning.
 */
export async function analyseAfterExploration(
    p: { db: object; sql: Sql; repo: Platform["repo"]; config: Platform["config"]; store: ObjectStore },
    projectId: string,
    o: { llm?: LlmClient; noAi?: string; signal: AbortSignal; createdBy?: string | null; now?: () => string; fetchText?: (url: string, signal?: AbortSignal) => Promise<string> },
): Promise<{ result?: AnalysisResult; error?: string }> {
    const before = of(running, p.db).get(projectId);
    if (before) {
        before.abort.abort();
        await before.done;
    }
    const now = o.now ?? (() => new Date().toISOString());
    // Registered like a manual one: a second start is refused meanwhile, and the job's cancel or time limit stops it.
    const task = track(
        p.db,
        projectId,
        0,
        async (signal) => {
            const inputs = await gatherAnalysisInputs({ db: p.repo.db, sql: p.sql, repo: p.repo, config: p.config }, projectId, { signal, fetchText: o.fetchText });
            return new AppAnalysis({ sql: p.sql, store: p.store, now }).run(projectId, inputs, { ...(o.llm ? { llm: o.llm } : { noAi: o.noAi }), signal, createdBy: o.createdBy ?? null });
        },
        now,
    );
    const stop = () => stopAnalysis(p.db, projectId);
    o.signal.addEventListener("abort", stop, { once: true });
    if (o.signal.aborted) stop();
    try {
        const result = await task.done;
        return result ? { result } : { error: of(finished, p.db).get(projectId)?.error ?? ANALYSIS_STOPPED };
    } finally {
        o.signal.removeEventListener("abort", stop);
    }
}
