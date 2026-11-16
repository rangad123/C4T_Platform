/**
 * The understanding benchmark command's pure parts (src/eval/bench/understanding/run.ts and the scorer's screen rule): the options for
 * recorded judgements and for the requirements variant, which judgements apply to which trial, the whole document as one requirement
 * record, AI calls by purpose, and answer-key screens left out of U1 because no crawl can reach them. Expected values are worked out by
 * hand from the definitions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppModelSchema } from "../src/engine/intel/model.js";
import { BENCH_APPS } from "../src/eval/bench/apps.js";
import { AnswerKeySchema, type Judgements } from "../src/eval/bench/understanding/answer-key.js";
import { callsByPurpose, judgementFor, loadJudgements, parseUnderstandingArgs, wholeDocumentRequirement } from "../src/eval/bench/understanding/run.js";
import { screenRecall } from "../src/eval/bench/understanding/score.js";

const judgement = (over: Partial<Judgements> = {}): Judgements => ({
    app: "bench-shop",
    inputs: "full",
    engine: "candidate",
    trial: 1,
    modelVersion: 1,
    answerKeySha256: "a".repeat(64),
    recordedBy: "lead",
    ownerReviewed: false,
    recordedAt: "2026-11-16T10:00:00.000Z",
    links: [],
    workflowLinks: [],
    reviews: [],
    ...over,
});

describe("options", () => {
    it("--doc is records (the default) or whole, and only with --inputs full", () => {
        expect(parseUnderstandingArgs(["--inputs", "full"]).doc).toBe("records");
        expect(parseUnderstandingArgs(["--inputs", "full", "--doc", "whole"]).doc).toBe("whole");
        expect(() => parseUnderstandingArgs(["--inputs", "full", "--doc", "half"])).toThrow(/--doc is records or whole/);
        expect(() => parseUnderstandingArgs(["--doc", "whole"])).toThrow(/--doc needs --inputs full/);
    });
    it("--judgements names a file", () => {
        expect(parseUnderstandingArgs(["--judgements", "j.json"]).judgements).toBe(path.resolve("j.json"));
    });
});

describe("recorded judgements", () => {
    const write = (content: unknown) => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aitp-judgements-")), "j.json");
        fs.writeFileSync(f, JSON.stringify(content));
        return f;
    };
    const keys = new Map([["bench-shop", "a".repeat(64)]]);
    it("a file holds one trial's judgements or a list of them", () => {
        expect(loadJudgements(write(judgement()), { inputs: "full", keys })).toHaveLength(1);
        expect(loadJudgements(write([judgement(), judgement({ trial: 2 })]), { inputs: "full", keys })).toHaveLength(2);
    });
    it("refuses judgements for an app not in the run, another answer key, another configuration, or one trial twice", () => {
        expect(() => loadJudgements(write(judgement({ app: "bench-rbac" })), { inputs: "full", keys })).toThrow(/bench-rbac/);
        expect(() => loadJudgements(write(judgement({ answerKeySha256: "c".repeat(64) })), { inputs: "full", keys })).toThrow(/another version of the answer key/);
        expect(() => loadJudgements(write(judgement()), { inputs: "url", keys })).toThrow(/full/);
        expect(() => loadJudgements(write([judgement(), judgement()]), { inputs: "full", keys })).toThrow(/twice/);
    });
    it("a trial gets the judgements recorded for its app, side and trial number, and only for the model version scored", () => {
        const list = [judgement({ trial: 1 }), judgement({ trial: 2, modelVersion: 3 }), judgement({ engine: "baseline", trial: 1 })];
        expect(judgementFor(list, { app: "bench-shop", engine: "candidate", trial: 1, modelVersion: 1 })).toEqual({ judgements: list[0] });
        expect(judgementFor(list, { app: "bench-shop", engine: "candidate", trial: 3, modelVersion: 1 })).toEqual({});
        expect(judgementFor(list, { app: "bench-shop", engine: "candidate", trial: 2, modelVersion: 2 })).toEqual({ note: "The judgements for this trial were recorded for model version 3, not 2: not applied." });
    });
});

describe("the whole requirements document as one record", () => {
    it("titled by its first heading, every line kept in order; text past the description's limit continues in the acceptance criteria", () => {
        const text = "# Shop: requirements\n\nScope line.\n\n## 1. Cart\n\n- 1.1 A cart has lines.\n";
        expect(wholeDocumentRequirement(text, 4000)).toEqual({ ref: "requirements", title: "Shop: requirements", description: "Scope line.\n\n## 1. Cart\n\n- 1.1 A cart has lines.", acceptanceCriteria: "" });
        // A limit of 40 characters: the first four lines are 11 + 1 + 0 + 1 + 10 + 1 + 0 = 24 characters; the fifth would make 47.
        const split = wholeDocumentRequirement(text, 40);
        expect(split.description).toBe("Scope line.\n\n## 1. Cart\n");
        expect(split.acceptanceCriteria).toBe("- 1.1 A cart has lines.");
        expect(() => wholeDocumentRequirement(`# T\n${"x".repeat(50)}\n`, 20)).toThrow(/too long/);
        expect(() => wholeDocumentRequirement(`# T\n${"x\n".repeat(30)}`, 20)).toThrow(/too long/);
    });
    it("both benchmark documents fit", () => {
        for (const app of ["bench-shop", "bench-rbac"]) {
            const text = fs.readFileSync(path.join("src/eval/bench/inputs", `${app}-requirements.md`), "utf8");
            const r = wholeDocumentRequirement(text, 4000);
            expect(`${r.description}\n${r.acceptanceCriteria}`.replace(/\n+/g, "\n").trim()).toBe(text.split("\n").slice(1).join("\n").replace(/\n+/g, "\n").trim());
        }
    });
});

describe("AI calls by purpose", () => {
    it("analysis is reading the application, planning is planning the exploration, the rest is other", () => {
        const groups = [
            { key: "analysis", calls: 3 },
            { key: "planning", calls: 6 },
            { key: "vision", calls: 1 },
            { key: "other", calls: 2 },
        ];
        expect(callsByPurpose(groups)).toEqual({ analysis: 3, planning: 6, other: 3 });
        expect(callsByPurpose([])).toEqual({ analysis: 0, planning: 0, other: 0 });
    });
});

describe("screens no crawl can reach", () => {
    const key = AnswerKeySchema.parse({
        app: "x",
        version: "1",
        review: "approved",
        catalogueVersion: "t",
        requirementsDocument: "x.md",
        screens: [
            { id: "cart", path: "/cart", name: "Cart", signIn: true },
            { id: "review", path: "/checkout/review", name: "Review", signIn: true },
            { id: "orders", path: "/orders", name: "Orders", signIn: true },
        ],
        workflows: [{ id: "w", name: "W", screens: ["cart"] }],
        rules: [],
    });
    it("are left out of U1 and listed", () => {
        const model = AppModelSchema.parse({ pages: [{ id: "p1", path: "/cart" }] });
        expect(screenRecall(model, key, ["review"])).toEqual({ found: 1, total: 2, value: 0.5, missed: ["orders"], notReachable: ["review"] });
        expect(screenRecall(model, key)).toEqual({ found: 1, total: 3, value: 1 / 3, missed: ["orders", "review"] });
    });
    it("the benchmark apps name only answer-key screens, each with a reason", () => {
        for (const app of BENCH_APPS) {
            const k = JSON.parse(fs.readFileSync(path.join("src/eval/bench/answers", `${app.id}.json`), "utf8")) as { screens: Array<{ id: string }> };
            for (const s of app.understanding?.notReachableScreens ?? []) {
                expect(k.screens.map((x) => x.id), app.id).toContain(s.id);
                expect(s.why.length, s.id).toBeGreaterThan(10);
            }
        }
    });
});
