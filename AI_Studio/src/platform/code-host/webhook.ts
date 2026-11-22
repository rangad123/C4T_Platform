/**
 * GitHub's webhook for a connected repository (Phase 6, G2): `POST /api/code-host/github/:token`. The address's token says which
 * connection a delivery is for (only its hash is stored); the delivery counts only when `X-Hub-Signature-256` is the HMAC of the exact
 * body under that connection's webhook secret, compared in constant time. Then, in this order: the delivery must be for the connected
 * repository, at most WEBHOOK_LIMIT_PER_MINUTE are taken per project, and a delivery id or a body already seen acts no more (GitHub's
 * redelivery, and a captured delivery replayed under a made-up id: the id is not signed). A pull request opened or pushed to queues an
 * impact analysis, unless it comes from a fork (its code must not run with this project's secrets), and the analysis starts once the
 * delivery is answered (pr-impact.ts); a deployment that succeeded queues a re-verification of the project's findings. The API key
 * check lets exactly this route through (isTriggerTokenRoute in trigger-store.ts); nothing GitHub sent is answered back.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "../routes/types.js";
import { processPrEvent } from "./pr-impact.js";
import { checkFixesOfDeployment } from "../findings/regression-service.js";
import type { CodeHostStore, PrEvent } from "./store.js";

export const WEBHOOK_LIMIT_PER_MINUTE = 30;
const MAX_BODY = 1_000_000;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_NAME = /^[a-z_]{1,40}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const webhookPath = (token: string) => `/api/code-host/github/${token}`;

/** True when `header` is `sha256=<hex HMAC-SHA256 of body under secret>`; constant time over the digest. */
export function signatureOk(secret: string | undefined, body: Buffer, header: string | undefined): boolean {
    if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const got = Buffer.from(header.slice("sha256=".length), "hex");
    const want = createHmac("sha256", secret).update(body).digest();
    return got.length === want.length && timingSafeEqual(got, want);
}

type Json = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const sha = (v: unknown) => (typeof v === "string" && SHA.test(v) ? v : undefined);
const prNumber = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);

/** What a verified delivery asks for. */
export function decide(event: string, body: Json): Omit<PrEvent, "deliveryId"> {
    if (event === "pull_request") {
        const pr = body.pull_request as Json | undefined;
        const base = { event, action: str(body.action), pr: prNumber(body.number ?? pr?.number), headSha: sha(pr?.head?.sha) };
        if (base.action !== "opened" && base.action !== "synchronize") return { ...base, ignored: `pull request ${base.action ?? "event"}: nothing to analyse` };
        const head = str(pr?.head?.repo?.full_name);
        // A deleted fork has no repository; it is still not this one.
        if (!head || head.toLowerCase() !== str(pr?.base?.repo?.full_name)?.toLowerCase()) return { ...base, ignored: "from a fork: its code is not run with this project's secrets" };
        if (!base.pr || !base.headSha) return { ...base, ignored: "the pull request number or head commit is missing" };
        return { ...base, queued: "impact" };
    }
    if (event === "deployment_status") {
        const state = str(body.deployment_status?.state);
        const base = { event, action: state, headSha: sha(body.deployment?.sha), environment: str(body.deployment?.environment)?.slice(0, 100) };
        if (state !== "success") return { ...base, ignored: `deployment ${state ?? "status"}: only a successful deployment is re-verified` };
        // The findings its pull request says it fixes ("Fixes #n") are checked on it (findings/regression-service.ts).
        if (!base.headSha) return { ...base, ignored: "the deployment's commit is missing" };
        return { ...base, queued: "reverify" };
    }
    return { event, action: str(body.action), ignored: event === "ping" ? "ping" : "an event this server does not use" };
}

export function registerCodeHostWebhook(ctx: RouteCtx, store: CodeHostStore): void {
    // Per project, a fixed one-minute window: GitHub sends one delivery per push, so more than this is a loop or an attack.
    const windows = new Map<string, { start: number; n: number }>();
    const take = (projectId: string): boolean => {
        const t = Date.now();
        const w = windows.get(projectId);
        if (!w || t - w.start >= 60_000) {
            windows.set(projectId, { start: t, n: 1 });
            return true;
        }
        return ++w.n <= WEBHOOK_LIMIT_PER_MINUTE;
    };

    ctx.app.register(async (scope) => {
        // The signature is over the exact bytes GitHub sent, so this route keeps the body as it came.
        scope.removeContentTypeParser("application/json");
        scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

        scope.post("/api/code-host/github/:token", async (req, reply) => {
            const { token } = req.params as { token: string };
            const repo = store.byHookToken(token);
            if (!repo) throw new HttpError(404, "Not found");
            const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            const header = req.headers["x-hub-signature-256"];
            if (!signatureOk(repo.webhookSecret, raw, typeof header === "string" ? header : undefined)) throw new HttpError(401, "The delivery's signature does not match this repository's webhook secret.");
            const event = String(req.headers["x-github-event"] ?? "");
            const deliveryId = String(req.headers["x-github-delivery"] ?? "");
            if (!EVENT_NAME.test(event) || !DELIVERY_ID.test(deliveryId)) throw new HttpError(400, "A GitHub delivery has the X-GitHub-Event and X-GitHub-Delivery headers.");
            let body: Json;
            try {
                body = JSON.parse(raw.toString("utf8")) as Json;
            } catch {
                throw new HttpError(400, "Send the delivery as application/json.");
            }
            if (!body || typeof body !== "object") throw new HttpError(400, "Send the delivery as application/json.");
            if (str(body.repository?.full_name)?.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) throw new HttpError(400, "This delivery is for another repository than the one connected to this project.");
            if (!take(repo.projectId)) return reply.header("retry-after", "60").code(429).send({ error: `At most ${WEBHOOK_LIMIT_PER_MINUTE} deliveries a minute are taken for a project.` });
            const what = decide(event, body);
            if (!store.recordEvent(repo.projectId, { deliveryId, bodySha: createHash("sha256").update(raw).digest("hex"), ...what })) return reply.code(200).send({ duplicate: true });
            // GitHub waits about ten seconds for an answer: the analysis runs after it (pr-impact.ts), and its failure is only logged.
            // shortcut: a restart loses an analysis still running; its pr_events row stays, with no pr_selections row for that head. Upgrade to a job kind if that is seen.
            if (what.queued === "reverify") void checkFixesOfDeployment(ctx.p, store, repo.projectId, what.headSha!).catch((err) => console.error(`[code-host] the fix check of deployment ${what.headSha!.slice(0, 7)} failed:`, err instanceof Error ? err.message : err));
            if (what.queued === "impact") void processPrEvent(ctx.p, store, repo.projectId, { pr: what.pr!, headSha: what.headSha! }).catch((err) => console.error(`[code-host] impact analysis of pull request #${what.pr} failed:`, err instanceof Error ? err.message : err));
            return what.queued ? reply.code(202).send({ queued: what.queued }) : reply.code(200).send({ ignored: what.ignored });
        });
    });
}
