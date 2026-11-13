import { randomUUID } from "node:crypto";
import { z } from "zod";
import { clean, MAX_CASES } from "../../engine/manual/cases.js";
import { batchesOf, generateCasesForBatch, MAX_GENERATE_REQUIREMENTS, NO_MODEL_FOR_CASES, type GeneratedCase, type RequirementForCases } from "../../engine/manual/generate.js";
import { classifyLlmError, describeLlmError } from "../../engine/llm/errors.js";
import { aiOwnerOfActor, personLlm } from "../ai-config.js";
import { currentActor } from "../auth/actor.js";
import { JobMeter } from "../../engine/llm/metered.js";
import { ManualCaseStore } from "../manual-case-store.js";
import { projectSetupOf } from "../project-setup.js";
import { extractDocumentText, REQUIREMENTS_MAX_CHARS, RequirementsDocumentError } from "../../engine/requirements/extract.js";
import { HttpError } from "../http-error.js";
import {
    candidatesFromText,
    candidatesWithAi,
    COVERAGE_STATES,
    MAX_LINK_BATCH,
    MAX_REF,
    MAX_REQUIREMENTS,
    MAX_TEXT,
    MAX_TITLE,
    REF_PATTERN,
    REQUIREMENT_PRIORITIES,
    REQUIREMENT_STATUSES,
    RequirementError,
    RequirementStore,
    type ImportCandidate,
} from "../requirement-store.js";
import { aiSkipReason, usageStoreFor } from "../usage-store.js";
import { assertHoldsHere } from "../auth/access.js";
import type { RouteCtx } from "./types.js";

/**
 * Requirements as records, and which test cases cover them (requirement-store.ts).
 *
 *   GET/POST      /api/projects/:id/requirements                    list (?q, status, coverage) with coverage; add one
 *   GET           /api/projects/:id/requirements/coverage           the coverage summary (the project dashboard)
 *   GET           /api/projects/:id/requirements/links              every link: what each test covers (the test lists)
 *   POST          /api/projects/:id/requirements/import/preview     { text } or { file: { filename, contentBase64 } }: what would be imported, no AI
 *   POST          /api/projects/:id/requirements/import/refine      the same, refined by the AI model (only when one is set up)
 *   POST          /api/projects/:id/requirements/import             { requirements: [...], source } save what the person kept
 *   POST          /api/projects/:id/requirements/generate-cases     { requirementIds } written test cases from them, by the AI model
 *   GET/PATCH/DELETE /api/projects/:id/requirements/:rid            one requirement with its tests; change; delete (?confirm=1 when tests link to it)
 *   POST          /api/projects/:id/requirements/:rid/tests         { automated: [ids], manual: [ids] } link tests
 *   DELETE        /api/projects/:id/requirements/:rid/tests/:testId unlink one
 *   GET           /api/tests/:id/requirements                       the requirements a test covers
 *
 * Every lookup is by project and id together: another project's requirement or test answers 404.
 */

const Text = (max: number, what: string) =>
    z
        .string({ error: (iss) => (iss.input === undefined ? `${what} is required` : `${what} must be text`) })
        .transform(clean)
        .pipe(z.string().max(max, `${what} can be at most ${max} characters`));
const Ref = Text(MAX_REF, "The reference").pipe(z.string().refine((s) => s === "" || REF_PATTERN.test(s), "A reference uses letters, digits and . _ # -, like REQ-12"));
const Title = Text(MAX_TITLE, "The title").pipe(z.string().min(1, "The title is required"));

const Fields = {
    ref: Ref,
    title: Title,
    description: Text(MAX_TEXT, "The description"),
    acceptanceCriteria: Text(MAX_TEXT, "The acceptance criteria"),
    priority: z.enum(REQUIREMENT_PRIORITIES, { error: () => "The priority is critical, high, medium or low" }),
    status: z.enum(REQUIREMENT_STATUSES, { error: () => "The status is draft, active or retired" }),
};
const NewRequirement = z.object({ ...Fields, ref: Fields.ref.optional(), description: Fields.description.default(""), acceptanceCriteria: Fields.acceptanceCriteria.default(""), priority: Fields.priority.default("medium"), status: Fields.status.default("active") });
const Patch = z.object(Fields).partial().refine((p) => Object.keys(p).length > 0, "Nothing to change");
const ListQuery = z.object({ q: z.string().max(200).optional(), status: z.enum(REQUIREMENT_STATUSES).optional(), coverage: z.enum(COVERAGE_STATES).optional() });
const Source = z
    .object({
        text: z.string().max(REQUIREMENTS_MAX_CHARS, `The text can be at most ${REQUIREMENTS_MAX_CHARS} characters`).optional(),
        file: z.object({ filename: z.string().min(1).max(200), contentBase64: z.string().min(1) }).optional(),
    })
    .refine((b) => Boolean(b.text?.trim()) !== Boolean(b.file), "Paste the requirements or choose a file (one of them)");
const ImportBody = z.object({
    requirements: z.array(z.object({ ...Fields, ref: Fields.ref.optional(), description: Fields.description.default(""), acceptanceCriteria: Fields.acceptanceCriteria.default(""), priority: Fields.priority.default("medium"), status: Fields.status.default("active") })).min(1, "There is nothing to import").max(MAX_REQUIREMENTS),
    source: z.enum(["imported", "ai"]).default("imported"),
});
const LinkBody = z.object({ automated: z.array(z.string().max(64)).max(MAX_LINK_BATCH).default([]), manual: z.array(z.string().max(64)).max(MAX_LINK_BATCH).default([]) }).refine((b) => b.automated.length + b.manual.length > 0, "Choose at least one test to link");

const GenerateBody = z.object({
    requirementIds: z
        .array(z.string().min(1).max(64))
        .min(1, "Choose at least one requirement")
        .max(MAX_GENERATE_REQUIREMENTS, `Choose at most ${MAX_GENERATE_REQUIREMENTS} requirements at a time`)
        .transform((ids) => [...new Set(ids)]),
});

const NO_MODEL = "No AI model is set up here, so the requirements can only be read without AI. The preview without AI still works.";

export function registerRequirementRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new RequirementStore(p.sql);
    const cases = new ManualCaseStore(p.db);
    const projectId = (req: { params: unknown }): string => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return id;
    };
    const requirement = async (pid: string, rid: string) => {
        const r = await store.get(pid, rid);
        if (!r) throw new HttpError(404, "Requirement not found");
        return r;
    };
    const refusal = (e: unknown): never => {
        if (e instanceof RequirementError) throw new HttpError(e.code === "duplicate" || e.code === "limit" ? 409 : 400, e.message);
        throw e;
    };
    /** The document's text: pasted, or read from a .txt, .md, .docx or .pdf file. */
    const sourceText = async (body: unknown): Promise<string> => {
        const b = Source.parse(body);
        if (b.text !== undefined && b.text.trim()) return b.text;
        try {
            return await extractDocumentText({ name: b.file!.filename, data: Buffer.from(b.file!.contentBase64, "base64") });
        } catch (e) {
            if (e instanceof RequirementsDocumentError) throw new HttpError(400, e.message);
            throw e;
        }
    };
    const preview = async (pid: string, candidates: ImportCandidate[], usedAi: boolean, note: string | null = null) => {
        const taken = await store.takenRefs(pid);
        const list = candidates.slice(0, MAX_REQUIREMENTS).map((c) => ({ ...c, exists: taken.has(c.ref.toUpperCase()) }));
        return { candidates: list, total: candidates.length, existing: list.filter((c) => c.exists).length, usedAi, note, max: MAX_REQUIREMENTS };
    };

    app.get("/api/projects/:id/requirements", async (req) => {
        const pid = projectId(req);
        const f = ListQuery.parse(req.query);
        const all = await store.list(pid);
        const q = f.q?.trim().toLowerCase();
        const shown = all.filter((r) => (!f.status || r.status === f.status) && (!f.coverage || r.coverage === f.coverage) && (!q || `${r.ref}\n${r.title}\n${r.description}\n${r.acceptanceCriteria}`.toLowerCase().includes(q)));
        // How many written test cases come from each requirement (the generate-cases chooser says so).
        const written = cases.countByRequirement(pid);
        return { requirements: shown.map((r) => ({ ...r, caseCount: written.get(r.id) ?? 0 })), total: all.length, max: MAX_REQUIREMENTS, summary: await store.summary(pid) };
    });

    app.post("/api/projects/:id/requirements", async (req, reply) => {
        const pid = projectId(req);
        const input = NewRequirement.parse(req.body);
        try {
            return reply.code(201).send(await store.create(pid, input, "typed"));
        } catch (e) {
            return refusal(e);
        }
    });

    app.get("/api/projects/:id/requirements/coverage", async (req) => store.summary(projectId(req)));

    app.get("/api/projects/:id/requirements/links", async (req) => ({ links: await store.allLinks(projectId(req)) }));

    app.post("/api/projects/:id/requirements/import/preview", async (req) => {
        const pid = projectId(req);
        return preview(pid, candidatesFromText(await sourceText(req.body)), false);
    });

    app.post("/api/projects/:id/requirements/import/refine", async (req) => {
        const pid = projectId(req);
        const text = await sourceText(req.body);
        // The asking person's chosen AI key and who pays for it (ai-config.ts): a signed-in person never reaches the server's key.
        const { llm, billing, blocked } = await personLlm(p, aiOwnerOfActor(currentActor()));
        if (llm.modelName === "unavailable") throw new HttpError(422, blocked ?? NO_MODEL, { modelMissing: true });
        const usage = usageStoreFor(p.db, p.config);
        const skip = aiSkipReason(usage, pid);
        if (skip) throw new HttpError(409, "The AI token limit was reached, so the AI cannot read these now. Reading without AI still works.");
        // Counted against the AI budgets like a job's calls, under an id of its own (ai_usage keeps no foreign key on it).
        const meter = new JobMeter({ backend: usage, jobId: `requirements-${randomUUID()}`, projectId: pid, billing });
        const r = await candidatesWithAi({ config: p.config, llm: meter.wrap(llm) }, text).finally(() => meter.finish());
        return preview(pid, r.candidates, r.usedAi, r.note);
    });

    app.post("/api/projects/:id/requirements/import", async (req, reply) => {
        const pid = projectId(req);
        const body = ImportBody.parse(req.body);
        try {
            const r = await store.importMany(pid, body.requirements, body.source);
            return reply.code(r.created.length ? 201 : 200).send({ created: r.created.length, duplicates: r.duplicates, total: await store.count(pid) });
        } catch (e) {
            return refusal(e);
        }
    });

    app.post("/api/projects/:id/requirements/generate-cases", async (req, reply) => {
        const pid = projectId(req);
        // ROUTE_PERMISSIONS asks for the AI's permission (ai_studio.tests.generate); the cases are saved, so adding tests is needed too.
        assertHoldsHere(ctx.app, req, pid, "ai_studio.tests.write");
        const { requirementIds } = GenerateBody.parse(req.body);
        const modes = projectSetupOf(ctx.project(pid)).testingModes;
        if (!modes.includes("code")) throw new HttpError(409, "Test cases are written for code-based projects. In an AI agent project the agents decide what to check.");
        const chosen: RequirementForCases[] = [];
        for (const rid of requirementIds) {
            const r = await requirement(pid, rid);
            chosen.push({ id: r.id, ref: r.ref, title: r.title, description: r.description, acceptanceCriteria: r.acceptanceCriteria });
        }
        const room = MAX_CASES - cases.countCases(pid);
        if (room <= 0) throw new HttpError(409, `This project already has ${MAX_CASES} test cases, the most it can have. Delete some before writing more.`);
        // The asking person's chosen AI key and who pays for it (ai-config.ts), as the import refinement does.
        const { llm, billing, blocked } = await personLlm(p, aiOwnerOfActor(currentActor()));
        if (llm.modelName === "unavailable") throw new HttpError(422, blocked ?? NO_MODEL_FOR_CASES, { modelMissing: true });
        const usage = usageStoreFor(p.db, p.config);
        if (aiSkipReason(usage, pid)) throw new HttpError(409, "The AI token limit was reached, so the AI cannot write test cases now. You can still add test cases by hand.");

        const row = ctx.project(pid);
        const platform = projectSetupOf(row).platforms[0] ?? "web";
        const app = { address: (repo.getLatestApplicationPublic(pid)?.url as string | undefined) ?? null, platform };
        const meter = new JobMeter({ backend: usage, jobId: `test-cases-${randomUUID()}`, projectId: pid, billing });
        const metered = meter.wrap(llm);
        const made: GeneratedCase[] = [];
        const failed: string[] = [];
        let problem: string | null = null;
        try {
            // One call per small batch, one after another: a failed batch is named, the others are kept.
            for (const batch of batchesOf(chosen)) {
                try {
                    made.push(...(await generateCasesForBatch(metered, batch, app)));
                } catch (e) {
                    failed.push(...batch.map((r) => r.ref));
                    problem = describeLlmError(classifyLlmError(e));
                }
            }
        } finally {
            meter.finish();
        }
        if (made.length === 0 && failed.length > 0) throw new HttpError(502, `The AI could not write test cases now, so nothing was saved. ${problem ?? ""}`.trim(), { failed });

        // Saved in one transaction that works out the room itself (a case added while the AI wrote counts), leaves out what is already
        // there before counting the room, and the cases of a requirement deleted meanwhile: the other requirements' cases are always kept.
        const saved = cases.addGenerated(pid, made.map((c) => c.input));
        for (const r of chosen) {
            const ids = saved.created.filter((c) => c.requirementId === r.id).map((c) => c.id);
            if (!ids.length) continue;
            try {
                await store.link(pid, r.id, { automated: [], manual: ids }, "generated");
            } catch {
                // Deleted after the save: the cases stay (their requirement was cleared with it), without the link.
            }
        }
        const gone = chosen.filter((r) => saved.gone.includes(r.id)).map((r) => r.ref);
        const perRequirement = chosen.map((r) => ({ id: r.id, ref: r.ref, created: saved.created.filter((c) => c.requirementId === r.id).length, failed: failed.includes(r.ref) }));
        const notes = [
            failed.length ? `The AI could not write test cases for ${failed.join(", ")}. Try ${failed.length === 1 ? "it" : "them"} again.` : "",
            // Every batch answered, but nothing in the answers could be used (no case named a requirement that was sent, or none had a title).
            made.length === 0 && failed.length === 0 ? "The AI answered, but none of what it wrote could be used as a test case, so nothing was saved. Try again, or add a description or acceptance criteria to the requirements." : "",
            saved.duplicates ? `${saved.duplicates} test case${saved.duplicates === 1 ? " was" : "s were"} already there and left out.` : "",
            gone.length ? `${gone.join(", ")} ${gone.length === 1 ? "was" : "were"} deleted while the AI was writing, so ${gone.length === 1 ? "its" : "their"} test cases were not saved.` : "",
            saved.limited ? `${saved.limited} more did not fit: a project can have at most ${MAX_CASES} test cases.` : "",
        ].filter(Boolean);
        return reply.code(saved.created.length ? 201 : 200).send({ created: saved.created.length, cases: saved.created, perRequirement, duplicates: saved.duplicates, limited: saved.limited > 0, failed, note: notes.join(" ") || null, total: cases.countCases(pid) });
    });

    app.get("/api/projects/:id/requirements/:rid", async (req) => {
        const pid = projectId(req);
        const { rid } = req.params as { rid: string };
        const r = await requirement(pid, rid);
        const [summary] = (await store.list(pid)).filter((x) => x.id === rid);
        return { ...r, coverage: summary!.coverage, counts: summary!.tests, tests: await store.linkedTests(pid, rid) };
    });

    app.patch("/api/projects/:id/requirements/:rid", async (req) => {
        const pid = projectId(req);
        const { rid } = req.params as { rid: string };
        await requirement(pid, rid);
        const patch = Patch.parse(req.body);
        try {
            return await store.update(pid, rid, patch);
        } catch (e) {
            return refusal(e);
        }
    });

    app.delete("/api/projects/:id/requirements/:rid", async (req, reply) => {
        const pid = projectId(req);
        const { rid } = req.params as { rid: string };
        const r = await requirement(pid, rid);
        const { confirm } = z.object({ confirm: z.enum(["1", "true"]).optional() }).parse(req.query);
        const linked = await store.linkCount(pid, rid);
        if (linked > 0 && !confirm) {
            throw new HttpError(409, `${r.ref} is covered by ${linked} test${linked === 1 ? "" : "s"}. Deleting it removes those links; the tests stay. Confirm to delete it.`, { linked });
        }
        await store.remove(pid, rid);
        return reply.code(204).send();
    });

    app.post("/api/projects/:id/requirements/:rid/tests", async (req) => {
        const pid = projectId(req);
        const { rid } = req.params as { rid: string };
        await requirement(pid, rid);
        const body = LinkBody.parse(req.body);
        try {
            const added = await store.link(pid, rid, body);
            return { added, tests: await store.linkedTests(pid, rid) };
        } catch (e) {
            if (e instanceof RequirementError && e.code === "not-found") throw new HttpError(404, e.message);
            return refusal(e);
        }
    });

    app.delete("/api/projects/:id/requirements/:rid/tests/:testId", async (req, reply) => {
        const pid = projectId(req);
        const { rid, testId } = req.params as { rid: string; testId: string };
        await requirement(pid, rid);
        if (!(await store.unlink(pid, rid, testId))) throw new HttpError(404, "That test is not linked to this requirement.");
        return reply.code(204).send();
    });

    app.get("/api/tests/:id/requirements", async (req) => {
        const { id } = req.params as { id: string };
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return { requirements: await store.forTest(t.projectId, id) };
    });
}
