/**
 * Seeding for the storage / retention tests: projects, tests, executions with fake (old) timestamps and real evidence files on
 * disk with matching artifact rows, written the way the worker writes them (through the repo and the artifact store).
 */
import fs from "node:fs";
import path from "node:path";
import { defaultFramework } from "../../src/engine/generators/index.js";
import { TestSpecSchema } from "../../src/engine/spec/schema.js";
import type { Platform } from "../../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../../src/platform/repo.js";

export const DAY = 86_400_000;
const framework = defaultFramework("api");

export interface Seed {
    projectId: string;
    appId: string;
}
export interface SeedTest {
    id: string;
    key: string;
    scriptId: string;
}
export interface SeedFile {
    id: string;
    kind: string;
    rel: string;
    abs: string;
    size: number;
}

export function seedProject(p: Platform, name: string, url = "http://127.0.0.1:5755"): Seed {
    const project = p.repo.createProject({ name });
    return { projectId: project.id, appId: p.repo.createApplication(project.id, url, { ...DEFAULT_JOB_OPTIONS }) };
}

let counter = 0;

export function addTest(p: Platform, s: Seed, title = "Check the home page", kind: "api" | "web" = "api"): SeedTest {
    const n = String(p.repo.listTests(s.projectId).length + 1).padStart(3, "0");
    const spec = TestSpecSchema.parse(
        kind === "api"
            ? { testId: `API-${n}`, title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] }
            : { testId: `WEB-${n}`, title, kind: "web", category: "Pages", steps: [{ action: "navigate", url: "/" }] },
    );
    const fw = defaultFramework(kind);
    const id = p.repo.insertTest({ projectId: s.projectId, suiteId: p.repo.getOrCreateSuite(s.projectId, kind === "api" ? "API" : "Pages", kind === "api" ? "api" : "pages"), jobId: null, spec, framework: fw, validationStatus: "PENDING" });
    const rel = `${s.projectId}/${kind === "api" ? "api" : "pages"}/${spec.testId}.spec.ts`;
    fs.mkdirSync(path.dirname(path.join(p.config.artifactsDir, rel)), { recursive: true });
    const content = `// test ${spec.testId}\n`;
    fs.writeFileSync(path.join(p.config.artifactsDir, rel), content);
    const scriptId = p.repo.addScript(id, { framework: fw, filename: `${spec.testId}.spec.ts`, content, hash: `h${++counter}`, storagePath: rel, executable: true });
    return { id, key: spec.testId, scriptId };
}

const EXT: Record<string, string> = { screenshot: "png", "visual-actual": "png", "visual-diff": "png", "vision-shot": "jpg", video: "webm", trace: "zip", evidence: "json" };

/** One execution `daysAgo` days before `now`, with real files of the given kinds and sizes. */
export function addRun(p: Platform, s: Seed, t: SeedTest, o: { daysAgo: number; status?: "passed" | "failed"; now?: number; files?: Array<{ kind: string; size?: number }>; variant?: string; environment?: string }): { executionId: string; files: SeedFile[] } {
    const at = new Date((o.now ?? Date.now()) - o.daysAgo * DAY).toISOString();
    const executionId = p.repo.addExecution({ testId: t.id, scriptId: t.scriptId, jobId: null, attempt: 1, status: o.status ?? "passed", durationMs: 5, error: o.status === "failed" ? "boom" : undefined, startedAt: at, steps: [] });
    p.db.run("UPDATE test_executions SET started_at = ?, finished_at = ?, variant = ?, environment = ? WHERE id = ?", at, at, o.variant ?? null, o.environment ?? null, executionId);
    const files: SeedFile[] = [];
    for (const f of o.files ?? []) {
        const rel = `${s.projectId}/_artifacts/${t.key}/run-${++counter}/${f.kind}.${EXT[f.kind] ?? "bin"}`;
        const abs = path.join(p.config.artifactsDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const size = f.size ?? 1000;
        fs.writeFileSync(abs, Buffer.alloc(size, 7));
        const id = p.repo.addArtifact({ projectId: s.projectId, testId: t.id, executionId, kind: f.kind, path: rel, size });
        files.push({ id, kind: f.kind, rel, abs, size });
    }
    return { executionId, files };
}

/** An approved visual baseline (a real PNG header so a backup accepts it as an image). */
export function addBaseline(p: Platform, s: Seed, t: SeedTest, name = "home.png"): SeedFile {
    const rel = `${s.projectId}/_baselines/${t.key}/${name}`;
    const abs = path.join(p.config.artifactsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);
    fs.writeFileSync(abs, bytes);
    const id = p.repo.addArtifact({ projectId: s.projectId, testId: t.id, kind: "baseline", path: rel, size: bytes.length });
    return { id, kind: "baseline", rel, abs, size: bytes.length };
}

export const exists = (f: SeedFile) => fs.existsSync(f.abs);
