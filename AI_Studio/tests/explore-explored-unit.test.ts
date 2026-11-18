/**
 * Queue row 173: the "not explored yet" priority (explore/priority.ts) is fed by the project's last exploration by objectives. The
 * platform reads what that exploration explored from its stored record (exploration-store.ts exploredObjectivesOf: the source refs
 * of the objectives a pursuit of which ran) and hands them to the engine in the request (GenerationRequest.exploredObjectives); the
 * objective stage passes them to the objectives, so an objective not explored yet outranks an equal one that was. No AI, no browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { objectivePursuits } from "../src/engine/orchestrator.js";
import type { AppKnowledge } from "../src/engine/planning/planner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { exploredObjectivesOf, exploredSources, saveExploration } from "../src/platform/exploration-store.js";
import { withoutObjectives } from "../src/platform/explore-task.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { seedProject, type Seed } from "./fixtures/dashboard-seed.js";
import { sampleExploration } from "./fixtures/exploration-record.js";

/** Two form fields with the same constraint: two objectives of the same kind, wording and priority. */
const knowledge = (): Pick<AppKnowledge, "rules" | "workflows" | "objectiveInputs"> => ({
    rules: [],
    workflows: [],
    objectiveInputs: {
        pages: [{ id: "page-signup", path: "/signup", forms: [{ name: "signup", fields: [{ name: "first", label: "First", required: true }, { name: "second", label: "Second", required: true }] }] }],
        transitions: [],
        workflowSteps: [],
    },
});
// Data operators allowed: the fields' invalid-input checks submit the form, so with data changes off they would not be pursuits at all.
const opts = { maxObjectives: 10, steps: 10, perObjective: { minutes: 5, tokens: 50_000 }, dataOperators: true, requiresAuth: false };

describe("an objective not explored yet outranks an equal explored one", () => {
    it("the objective stage passes the explored refs to the objectives", () => {
        const before = objectivePursuits(knowledge(), opts).objectives;
        expect(before).toHaveLength(2);
        expect(before[0]!.priority).toBe(before[1]!.priority);
        expect(before.every((o) => !/not explored yet/.test(o.reason))).toBe(true);

        // The one that ranked first was explored last time: the other now ranks above it, by the unexplored points, and says why.
        const [explored, other] = before;
        const after = objectivePursuits(knowledge(), { ...opts, explored: [explored!.source.ref] }).objectives;
        expect(after.map((o) => o.id)).toEqual([other!.id, explored!.id]);
        expect(after[0]!.priority).toBe(after[1]!.priority + 2);
        expect(after[0]!.reason).toMatch(/not explored yet/);
        expect(after[1]!.reason).not.toMatch(/not explored yet/);
        // Pursuits follow the objectives' priority.
        expect(objectivePursuits(knowledge(), { ...opts, explored: [explored!.source.ref] }).pursuits[0]!.objective.id).toBe(other!.id);
    });

    it("an empty list means nothing was explored, so every objective gets the points; a ref no objective could have is ignored", () => {
        const none = objectivePursuits(knowledge(), { ...opts, explored: [] }).objectives;
        expect(none.every((o) => /not explored yet/.test(o.reason))).toBe(true);
        const odd = objectivePursuits(knowledge(), { ...opts, explored: ["x".repeat(501), 7 as never] }).objectives;
        expect(odd.every((o) => /not explored yet/.test(o.reason))).toBe(true);
    });
});

describe("what the last exploration explored", () => {
    it("is the sources of the objectives with a pursuit that completed or was stopped by the loop", () => {
        const ran = (id: string, status: string) => ({ objectiveId: `${id}:as_stated`, status, reason: "", actions: 0 }) as never;
        const objective = (id: string, source: string) => ({ id, kind: "rule", source, priority: 1, reason: "r", operators: ["as_stated"] }) as never;
        const e = {
            objectives: [objective("OBJ-a", "R-2"), objective("OBJ-b", "R-1"), objective("OBJ-c", "R-3"), objective("OBJ-d", "R-4"), objective("OBJ-e", "R-2")],
            outcomes: [ran("OBJ-a", "completed"), ran("OBJ-b", "stopped"), ran("OBJ-c", "not_reached"), ran("OBJ-d", "environment_failure"), ran("OBJ-e", "completed")],
        };
        expect(exploredSources(e)).toEqual(["R-1", "R-2"]);
        expect(exploredSources(sampleExploration())).toEqual(["checkout"]);
    });

    let platform: Platform;
    let dir = "";
    let A: Seed;
    let B: Seed;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explored-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "explored-test-secret-key-0123456789", API_KEY: "explored-key-0123", SCHEDULER_ENABLED: "false" }));
        A = seedProject(platform, "Explored A");
        B = seedProject(platform, "Explored B");
    });
    afterAll(async () => {
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const explore = async (s: Seed, source: string) => {
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
        const e = sampleExploration();
        await saveExploration(sink, { ...e, objectives: [{ ...e.objectives[0]!, source }] });
        await sink.writes.flush();
    };

    it("is read from the project's own latest exploration record, for the request", async () => {
        expect(await exploredObjectivesOf(platform.repo, platform.store, A.projectId)).toEqual({});
        await explore(A, "checkout-old");
        await explore(A, "checkout-new");
        await explore(B, "other-project");
        expect(await exploredObjectivesOf(platform.repo, platform.store, A.projectId)).toEqual({ exploredObjectives: ["checkout-new"] });
        expect(await exploredObjectivesOf(platform.repo, platform.store, B.projectId)).toEqual({ exploredObjectives: ["other-project"] });
    });

    it("goes with exploring by objectives: an older runner's request carries neither", () => {
        expect(withoutObjectives({ url: "http://x", objectives: true, exploredObjectives: ["R-1"] })).toEqual({ url: "http://x" });
    });
});
