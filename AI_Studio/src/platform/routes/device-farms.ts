/**
 * Device farm routes (Settings → Mobile app → Device farm): connect a provider account, pick its phones, choose where the project's phone tests run, check a
 * connection, and list past farm sessions with their links. Credentials are write-only: no answer carries them, and the check only ever talks to the
 * provider's own address (or the Appium server's, which passed the outbound guard).
 */
import { z } from "zod";
import { checkRequest, connectionProblem, endpointsFor, PROVIDERS } from "../../engine/mobile/cloud/providers.js";
import { FARM_LIMITS, FarmDeviceSchema, PROVIDER_IDS, SAUCE_REGIONS, type FarmConnection } from "../../engine/mobile/cloud/types.js";
import { wdRequest, WebDriverError } from "../../engine/mobile/cloud/webdriver.js";
import { farmStoreFor } from "../device-farm-run.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { NEW_PASSWORD_NEEDED } from "./shared-integrations.js";
import type { RouteCtx } from "./types.js";

const Label = z.string().trim().min(1, "Give the connection a name.").max(FARM_LIMITS.labelMax);
const Credential = z.string().trim().max(FARM_LIMITS.credentialMax).regex(/^[\x21-\x7e]*$/, "Sign-in details can't contain spaces or special characters.");
const Devices = z.array(FarmDeviceSchema).min(1, "Pick at least one phone to run on.").max(FARM_LIMITS.devicesPerConnection, `At most ${FARM_LIMITS.devicesPerConnection} phones per connection.`);
const HubUrl = z.string().trim().max(FARM_LIMITS.hubUrlMax);

const CreateBody = z
    .object({
        provider: z.enum(PROVIDER_IDS),
        label: Label,
        region: z.enum(SAUCE_REGIONS).optional(),
        hubUrl: HubUrl.optional(),
        devices: Devices,
        username: Credential.optional(),
        accessKey: Credential.optional(),
    })
    .strict();

const UpdateBody = z
    .object({
        label: Label.optional(),
        region: z.enum(SAUCE_REGIONS).nullable().optional(),
        hubUrl: HubUrl.nullable().optional(),
        devices: Devices.optional(),
        username: Credential.optional(),
        accessKey: Credential.optional(),
    })
    .strict();

const ChoiceBody = z
    .object({
        runOn: z.enum(["device", "farm"]),
        farmId: z.string().uuid().nullable().optional(),
        parallel: z.number().int().min(1).max(FARM_LIMITS.maxParallel).default(1),
        matrix: z.boolean().default(false),
    })
    .strict();

/** The site (scheme, host and port) of an address, or the address itself when it is not one. */
const siteOf = (url: string | null | undefined): string => {
    if (!url) return "";
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
};

/** The settings a connection would have, checked the way a run checks them (plain sentence on a problem). */
async function assertUsable(conn: FarmConnection): Promise<void> {
    const problem = connectionProblem(conn);
    if (problem) throw new HttpError(400, problem);
    if (conn.provider === "appium") await assertAllowedTarget(conn.hubUrl!);
}

export function registerDeviceFarmRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const store = () => farmStoreFor(ctx.repo, p.config);
    const params = (req: { params: unknown }) => req.params as { id: string; farmId?: string };

    app.get("/api/projects/:id/device-farms", async (req) => {
        const { id } = params(req);
        ctx.project(id);
        const s = store();
        return {
            providers: Object.values(PROVIDERS),
            limits: FARM_LIMITS,
            farms: s.list(id),
            choice: s.choice(id),
        };
    });

    app.post("/api/projects/:id/device-farms", async (req, reply) => {
        const { id } = params(req);
        ctx.project(id);
        const body = CreateBody.parse(req.body);
        const s = store();
        if (s.count(id) >= FARM_LIMITS.connectionsPerProject) throw new HttpError(409, `A project can have at most ${FARM_LIMITS.connectionsPerProject} device farm connections. Remove one first.`);
        if (body.provider !== "appium" && body.hubUrl) throw new HttpError(400, "Only “Any Appium server” takes an address: the other farms have fixed ones.");
        if (body.provider !== "saucelabs" && body.region) throw new HttpError(400, "Only Sauce Labs has data centres to choose from.");
        const conn: FarmConnection = { id: "new", provider: body.provider, label: body.label, ...(body.region ? { region: body.region } : {}), ...(body.hubUrl ? { hubUrl: body.hubUrl.replace(/\/+$/, "") } : {}), devices: body.devices, ...(body.username ? { username: body.username } : {}), ...(body.accessKey ? { accessKey: body.accessKey } : {}) };
        await assertUsable(conn);
        const created = s.create(id, { provider: conn.provider, label: conn.label, ...(conn.region ? { region: conn.region } : {}), ...(conn.hubUrl ? { hubUrl: conn.hubUrl } : {}), devices: conn.devices, ...(conn.username ? { username: conn.username } : {}), ...(conn.accessKey ? { accessKey: conn.accessKey } : {}) });
        return reply.code(201).send(created);
    });

    app.put("/api/projects/:id/device-farms/:farmId", async (req) => {
        const { id, farmId } = params(req);
        ctx.project(id);
        const body = UpdateBody.parse(req.body);
        const s = store();
        const current = s.connection(id, farmId!);
        if (!current) throw new HttpError(404, "Device farm connection not found");
        if (current.provider !== "appium" && body.hubUrl) throw new HttpError(400, "Only “Any Appium server” takes an address: the other farms have fixed ones.");
        if (current.provider !== "saucelabs" && body.region) throw new HttpError(400, "Only Sauce Labs has data centres to choose from.");
        // The stored access key is only sent to the server it was entered for: an Appium address on another site needs it again.
        if (current.accessKey && body.accessKey === undefined && body.hubUrl !== undefined && siteOf(body.hubUrl) !== siteOf(current.hubUrl)) throw new HttpError(400, NEW_PASSWORD_NEEDED);
        const next: FarmConnection = {
            ...current,
            ...(body.label ? { label: body.label } : {}),
            ...(body.devices ? { devices: body.devices } : {}),
            ...(body.region !== undefined ? { region: body.region ?? undefined } : {}),
            ...(body.hubUrl !== undefined ? { hubUrl: body.hubUrl ? body.hubUrl.replace(/\/+$/, "") : undefined } : {}),
            ...(body.username !== undefined ? { username: body.username || undefined } : {}),
            ...(body.accessKey !== undefined ? { accessKey: body.accessKey || undefined } : {}),
        };
        await assertUsable(next);
        return s.update(id, farmId!, {
            ...(body.label ? { label: body.label } : {}),
            ...(body.devices ? { devices: body.devices } : {}),
            ...(body.region !== undefined ? { region: body.region } : {}),
            ...(body.hubUrl !== undefined ? { hubUrl: next.hubUrl ?? null } : {}),
            ...(body.username !== undefined ? { username: body.username } : {}),
            ...(body.accessKey !== undefined ? { accessKey: body.accessKey } : {}),
        });
    });

    app.delete("/api/projects/:id/device-farms/:farmId", async (req, reply) => {
        const { id, farmId } = params(req);
        ctx.project(id);
        if (!store().delete(id, farmId!)) throw new HttpError(404, "Device farm connection not found");
        return reply.code(204).send();
    });

    /** "Check connection": one read-only request with the stored account. Says in words whether it worked; never echoes what the provider sent back beyond that. */
    app.post("/api/projects/:id/device-farms/:farmId/check", async (req) => {
        const { id, farmId } = params(req);
        ctx.project(id);
        const conn = store().connection(id, farmId!);
        if (!conn) throw new HttpError(404, "Device farm connection not found");
        const problem = connectionProblem(conn);
        if (problem) return { ok: false, message: problem };
        if (conn.provider === "appium") await assertAllowedTarget(conn.hubUrl!);
        const label = PROVIDERS[conn.provider].label;
        const r = checkRequest(conn, endpointsFor(conn));
        try {
            await wdRequest({ hub: "", conn }, r.method, r.url, undefined, 20_000);
            return { ok: true, message: `Connected to ${label}. The sign-in details work.` };
        } catch (e) {
            return { ok: false, message: e instanceof WebDriverError ? e.message : `${label} could not be reached.` };
        }
    });

    app.put("/api/projects/:id/device-farm-choice", async (req) => {
        const { id } = params(req);
        ctx.project(id);
        const body = ChoiceBody.parse(req.body);
        const s = store();
        if (body.runOn === "farm") {
            if (!body.farmId) throw new HttpError(400, "Pick the device farm connection to run on.");
            const conn = s.connection(id, body.farmId);
            if (!conn) throw new HttpError(404, "Device farm connection not found");
            const problem = connectionProblem(conn);
            if (problem) throw new HttpError(400, problem);
        }
        return s.setChoice(id, { runOn: body.runOn, farmId: body.runOn === "farm" ? body.farmId! : null, parallel: body.parallel, matrix: body.runOn === "farm" ? body.matrix : false });
    });

    app.get("/api/projects/:id/device-farms/sessions", async (req) => {
        const { id } = params(req);
        ctx.project(id);
        const q = z.object({ testId: z.string().max(120).optional(), jobId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query ?? {});
        return { sessions: store().sessions(id, q) };
    });
}
