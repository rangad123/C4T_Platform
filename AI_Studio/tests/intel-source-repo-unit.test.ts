/**
 * Repository artefacts as sources: which files of a checked-out repository are read (OpenAPI, schema files, tests, documents) and which
 * are refused. The checkout is an in-memory tree; nothing touches the disk, the network or git (fast tier).
 */
import { describe, expect, it } from "vitest";
import { findRepoArtefacts, type RepoTree } from "../src/engine/intel/sources/repo.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function tree(files: Record<string, string | { mode?: string; type?: string; text?: string; size?: number }>): RepoTree & { reads: string[][] } {
    const blobs = new Map<string, Buffer>();
    const reads: string[][] = [];
    const entries = Object.entries(files).map(([path, f], i) => {
        const spec = typeof f === "string" ? { text: f } : f;
        const sha = String(i).padStart(40, "0");
        const buf = Buffer.from(spec.text ?? "");
        blobs.set(sha, buf);
        return { path, mode: spec.mode ?? "100644", type: spec.type ?? "blob", sha, size: spec.size ?? buf.length };
    });
    return {
        commit: COMMIT,
        entries,
        reads,
        async read(shas: string[]) {
            reads.push(shas);
            return new Map(shas.filter((s) => blobs.has(s)).map((s) => [s, blobs.get(s)!]));
        },
    };
}

const paths = (r: Awaited<ReturnType<typeof findRepoArtefacts>>) => r.artefacts.map((a) => `${a.kind} ${a.path}`).sort();

describe("repository artefacts", () => {
    it("finds OpenAPI documents, schema files, test files and documents, each with ref = path @ commit", async () => {
        const r = await findRepoArtefacts(
            tree({
                "openapi.yaml": "openapi: 3.0.3\ninfo:\n  title: Shop\npaths: {}\n",
                "api/swagger.json": '{"swagger":"2.0","paths":{}}',
                "db/schema.sql": "CREATE TABLE users (id int);",
                "prisma/schema.prisma": "model User {\n  id Int @id\n}\n",
                "tests/orders.spec.ts": "test('places an order', async () => {});",
                "e2e/checkout.test.js": "it('pays', () => {});",
                "README.md": "# Shop\nCustomers buy products.",
                "docs/orders.md": "Orders can be cancelled until shipped.",
                "package.json": '{"name":"shop"}',
            }),
        );
        expect(paths(r)).toEqual([
            "db_schema db/schema.sql",
            "db_schema prisma/schema.prisma",
            "existing_tests e2e/checkout.test.js",
            "existing_tests tests/orders.spec.ts",
            "openapi api/swagger.json",
            "openapi openapi.yaml",
            "requirements README.md",
            "requirements docs/orders.md",
        ]);
        const doc = r.artefacts.find((a) => a.path === "docs/orders.md")!;
        expect(doc.ref).toBe(`docs/orders.md@${COMMIT}`);
        expect(doc.text).toBe("Orders can be cancelled until shipped.");
    });

    it("does not return application code: handlers, servers, configuration", async () => {
        const r = await findRepoArtefacts(
            tree({
                "src/routes/orders.ts": "export function cancel(req, res) { if (order.shipped) return res.status(409).end(); }",
                "server.mjs": "http.createServer()",
                "src/models/order.py": "class Order: pass",
                "app/controllers/orders_controller.rb": "class OrdersController; end",
                "config/settings.yaml": "port: 3000",
                "src/api/openapi-client.ts": "export const client = {}",
            }),
        );
        expect(r.artefacts).toEqual([]);
    });

    it("refuses a symbolic link (e.g. to /etc/passwd) and never reads it", async () => {
        const t = tree({ "docs/passwd.md": { mode: "120000", text: "/etc/passwd" }, "README.md": "hello" });
        const r = await findRepoArtefacts(t);
        expect(paths(r)).toEqual(["requirements README.md"]);
        expect(r.skipped).toContainEqual({ path: "docs/passwd.md", reason: expect.stringMatching(/symbolic link/) });
        expect(t.reads.flat()).not.toContain(t.entries[0]!.sha);
    });

    it("refuses paths outside the copy: ../, absolute, backslashes", async () => {
        const r = await findRepoArtefacts(tree({ "../outside/README.md": "x", "/etc/schema.sql": "x", "docs\\..\\..\\a.md": "x", "docs/../../b.md": "x", "README.md": "ok" }));
        expect(paths(r)).toEqual(["requirements README.md"]);
        expect(r.skipped.filter((s) => /outside the repository/.test(s.reason))).toHaveLength(4);
    });

    it("skips what is not a regular file, binary content, and files over the size cap", async () => {
        const r = await findRepoArtefacts(
            tree({
                "vendor/README.md": { type: "commit", text: "" },
                "docs/image.md": { text: "a\u0000b" },
                "db/huge.sql": { text: "CREATE TABLE a (id int);", size: 5 * 1024 * 1024 },
            }),
        );
        expect(r.artefacts).toEqual([]);
        expect(r.skipped.map((s) => s.path).sort()).toEqual(["db/huge.sql", "docs/image.md", "vendor/README.md"]);
    });

    it("leaves out dependency and hidden folders", async () => {
        const r = await findRepoArtefacts(tree({ "node_modules/x/README.md": "x", ".github/README.md": "x", "node_modules/x/openapi.json": '{"openapi":"3.0.0"}' }));
        expect(r.artefacts).toEqual([]);
    });

    it("an OpenAPI-named file that is not an OpenAPI document is not one", async () => {
        const r = await findRepoArtefacts(tree({ "openapi.json": '{"name":"not a spec"}' }));
        expect(r.artefacts).toEqual([]);
    });

    it("caps how many files of one kind are read and says so", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 260; i++) files[`tests/t${String(i).padStart(3, "0")}.test.ts`] = "it('x', () => {});";
        const r = await findRepoArtefacts(tree(files));
        expect(r.artefacts).toHaveLength(200);
        expect(r.notes.join(" ")).toMatch(/200 test files/);
    });

    it("limits to a folder when one is given", async () => {
        const r = await findRepoArtefacts(tree({ "web/README.md": "web", "api/README.md": "api" }), { subpath: "api" });
        expect(paths(r)).toEqual(["requirements api/README.md"]);
    });
});
