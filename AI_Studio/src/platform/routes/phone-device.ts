/**
 * Phones, round 24 (DEVICE): the project's phone settings, "Is this phone ready?", the two reversible phone changes, and a person's answer when a
 * phone exploration waits for a one-time code.
 *
 *   GET  /api/projects/:id/phone-settings                  where phone tests run, how thorough, already signed in (+ what they mean)
 *   PUT  /api/projects/:id/phone-settings                  change them ({ runsOn?, depth?, keepSignedIn? }; null goes back to the default)
 *   GET  /api/projects/:id/phones                          the phones and emulators on the platform's computer, each with its ready check
 *   POST /api/projects/:id/phones/:serial/animations       { off: true } turns the three animation scales to 0 (saving the old values);
 *                                                          { off: false } puts them back
 *   POST /api/projects/:id/phones/:serial/stay-awake       { on: true } keeps the screen on while charging; { on: false } puts the old value back
 *   GET  /api/projects/:id/jobs/:jobId/phone-sign-in       the question the exploration is waiting on, if any
 *   POST /api/projects/:id/jobs/:jobId/phone-sign-in       { choice: "continue" | "skip" }
 *
 * Phones on a runner are listed by the runner itself (Settings, Runners; its check-computer runs the same ready check). Everything here is
 * read-only unless a person presses a button, and every change can be undone. Roles: auth/roles.ts; project scope: the /api/projects/:id prefix.
 */
import { z } from "zod";
import { Adb, AdbError } from "../../engine/mobile/device/adb.js";
import { launcherCall, resolveLauncher } from "../../engine/mobile/device/launcher.js";
import { checkPhoneReady, keepScreenOn, restoreAnimations, restoreScreenOn, turnAnimationsOff, type PhoneReadiness } from "../../engine/mobile/device/ready.js";
import { DEFAULT_DEPTH, DEPTHS, PHONE_DEPTHS, PhoneRunsOnSchema, SERIAL, effectiveRunsOn, keptPhoneSettings, phoneSettingsProblem, runsOnSentence, type PhoneRunsOn } from "../../engine/mobile/phone-settings.js";
import type { MobileTarget } from "../../engine/mobile/target.js";
import { connectionProblem } from "../../engine/mobile/cloud/providers.js";
import { farmStoreFor } from "../device-farm-run.js";
import { HttpError } from "../http-error.js";
import { answerQuestion, openQuestion } from "../phone-person-gate.js";
import { latestMobileRow, updateMobileTarget, withSaved } from "../phone-settings-store.js";
import type { RouteCtx } from "./types.js";

const SettingsBody = z
    .object({
        runsOn: PhoneRunsOnSchema.nullable().optional(),
        depth: z.enum(PHONE_DEPTHS).nullable().optional(),
        keepSignedIn: z.boolean().nullable().optional(),
        /** With runsOn "farm" and several farm connections: which one. */
        farmId: z.string().uuid().optional(),
    })
    .strict();

/** At most this many phones are checked in one answer (each check is a dozen short adb calls). */
export const MAX_CHECKED = 8;
const NO_ADB = "The Android tools (adb) are not on the computer that runs the platform, so its phones can’t be checked here. Phones on a runner are checked on the runner: run check-computer there.";
const NO_PHONE = "No phone or emulator is connected to the computer that runs the platform.";

export function registerPhoneDeviceRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;
    const farms = () => farmStoreFor(repo, p.config);

    /** The farm part of the answer: can "A device farm" be chosen, and is it the current choice? */
    const farmPart = (projectId: string) => {
        try {
            const s = farms();
            const usable = s.list(projectId).filter((c) => c.devices.length > 0);
            const choice = s.choice(projectId);
            const chosen = choice.runOn === "farm" && choice.farmId ? s.connection(projectId, choice.farmId) : undefined;
            return { connections: usable.map((c) => ({ id: c.id, label: c.label })), chosen: chosen ? { id: chosen.id, label: chosen.label } : null };
        } catch {
            return { connections: [], chosen: null };
        }
    };

    const answer = (projectId: string) => {
        const row = latestMobileRow(repo, projectId);
        const m = row?.mobile;
        const farm = farmPart(projectId);
        // A farm chosen under Device farm is the choice, whatever is stored here (one place decides: the farm's own setting).
        const stored = m?.runsOn ?? null;
        const effective: PhoneRunsOn = farm.chosen ? { kind: "farm" } : effectiveRunsOn(m);
        return {
            hasApp: Boolean(m?.appPackage || m?.apkPath),
            appPackage: m?.appPackage ?? null,
            runsOn: stored,
            effective,
            sentence: farm.chosen ? `Phone tests run on the device farm “${farm.chosen.label}”.` : runsOnSentence(m),
            exploredOn: m?.exploredOn ?? null,
            depth: m?.depth ?? DEFAULT_DEPTH,
            depths: PHONE_DEPTHS.map((d) => ({ id: d, ...DEPTHS[d] })),
            keepSignedIn: m?.keepSignedIn === true,
            cleanStart: m?.cleanStart === true,
            farm,
        };
    };

    app.get("/api/projects/:id/phone-settings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return answer(id);
    });

    app.put("/api/projects/:id/phone-settings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = SettingsBody.parse(req.body ?? {});
        // A run that is going on keeps the settings it started with; changing them now would describe something that is not happening.
        await ctx.assertNoActiveJob(id);
        const row = latestMobileRow(repo, id);
        if (!row?.mobile) throw new HttpError(409, "Add the phone app under Mobile app first. These settings belong to it.");
        if (body.runsOn?.kind === "explored" && !row.mobile.exploredOn) throw new HttpError(400, "The AI has not explored this app on a device yet. Choose another place, or explore the app first.");

        // "A device farm": the farm's own choice is set (the one connection there is, or the one named); any other choice switches the farm off.
        const s = farms();
        if (body.runsOn?.kind === "farm") {
            const usable = s.list(id).filter((c) => c.devices.length > 0);
            const pick = body.farmId ? usable.find((c) => c.id === body.farmId) : usable.length === 1 ? usable[0] : undefined;
            if (!usable.length) throw new HttpError(400, "No device farm is set up for this project. Add one under Device farm below, then choose it here.");
            if (!pick) throw new HttpError(400, body.farmId ? "That device farm connection was not found." : "This project has more than one device farm connection. Choose which one under Device farm below.");
            const conn = s.connection(id, pick.id);
            const problem = conn ? connectionProblem(conn) : "That device farm connection was not found.";
            if (problem) throw new HttpError(400, problem);
        }
        updateMobileTarget(repo, id, (cur) => {
            const kept = keptPhoneSettings(cur, { ...(body.runsOn !== undefined ? { runsOn: body.runsOn } : {}), ...(body.depth !== undefined ? { depth: body.depth } : {}), ...(body.keepSignedIn !== undefined ? { keepSignedIn: body.keepSignedIn } : {}) });
            const { runsOn: _r, depth: _d, keepSignedIn: _k, exploredOn: _e, phoneSetup: _p, ...rest } = cur;
            const out: MobileTarget = { ...rest, ...kept };
            const problem = phoneSettingsProblem(out);
            if (problem) throw new HttpError(400, problem);
            return out;
        });
        if (body.runsOn !== undefined) {
            const choice = s.choice(id);
            if (body.runsOn?.kind === "farm") {
                const usable = s.list(id).filter((c) => c.devices.length > 0);
                const pick = body.farmId ? usable.find((c) => c.id === body.farmId)! : usable[0]!;
                s.setChoice(id, { ...choice, runOn: "farm", farmId: pick.id });
            } else if (choice.runOn === "farm") s.setChoice(id, { ...choice, runOn: "device", farmId: null, matrix: false });
        }
        return answer(id);
    });

    // ── the phones on the platform's computer ───────────────────────────────

    const savedFor = (m: MobileTarget | undefined, serial: string) => ({
        ...(m?.phoneSetup?.animations?.[serial] ? { savedAnimations: m.phoneSetup.animations[serial] } : {}),
        ...(m?.phoneSetup?.stayAwake?.[serial] !== undefined ? { savedStayAwake: m.phoneSetup.stayAwake[serial] } : {}),
    });

    const checkOne = async (adb: Adb, d: { serial: string; state: string; emulator: boolean; model?: string | undefined }, m: MobileTarget | undefined): Promise<PhoneReadiness> => {
        const dev = adb.forSerial(d.serial).forReadiness();
        return checkPhoneReady((args) => dev.setupCall(args), {
            serial: d.serial,
            adbState: d.state,
            emulator: d.emulator,
            ...(d.model ? { model: d.model } : {}),
            ...(m?.appPackage ? { appPackage: m.appPackage } : {}),
            hasApk: Boolean(m?.apkPath),
            ...savedFor(m, d.serial),
            // The shared resolver (mobile/device/launcher.ts), without its last resort: monkey would start the app, and this check changes nothing.
            resolveLauncher: async (pkg, user) => {
                const r = await resolveLauncher(launcherCall(adb.forSerial(d.serial)), pkg, { user, allowMonkey: false });
                return r.component ? { component: r.component } : { problem: r.problem ?? "No launcher screen was found." };
            },
        });
    };

    app.get("/api/projects/:id/phones", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const m = latestMobileRow(repo, id)?.mobile;
        const adb = Adb.locate({ timeoutMs: 10_000 });
        if (!adb) return { available: false, reason: NO_ADB, phones: [] };
        let devices;
        try {
            devices = await adb.devices();
        } catch (e) {
            return { available: false, reason: e instanceof AdbError ? e.message : NO_ADB, phones: [] };
        }
        if (!devices.length) return { available: true, reason: NO_PHONE, phones: [] };
        // Real phones first (they are what this check is mostly for), then emulators.
        const list = [...devices].sort((a, b) => Number(a.emulator) - Number(b.emulator)).slice(0, MAX_CHECKED);
        const phones: PhoneReadiness[] = [];
        for (const d of list) phones.push(await checkOne(adb, d, m));
        return { available: true, phones, ...(devices.length > list.length ? { more: devices.length - list.length } : {}) };
    });

    /** The phone a change is for: on this computer, ready to talk to. */
    const phoneFor = async (serial: string) => {
        if (!SERIAL.test(serial)) throw new HttpError(400, "That device name is not usable.");
        const adb = Adb.locate({ timeoutMs: 10_000 });
        if (!adb) throw new HttpError(409, NO_ADB);
        const d = (await adb.devices().catch(() => [])).find((x) => x.serial === serial);
        if (!d) throw new HttpError(404, "That phone is not connected to the computer that runs the platform any more.");
        if (d.state !== "device") throw new HttpError(409, "That phone is not ready to be changed: allow USB debugging on it and unlock it first.");
        return { adb, d, setup: adb.forSerial(serial).forPhoneSetup() };
    };

    const changeRoute = (path: "animations" | "stay-awake") =>
        app.post(`/api/projects/:id/phones/:serial/${path}`, async (req) => {
            const { id, serial } = req.params as { id: string; serial: string };
            ctx.project(id);
            const body = (path === "animations" ? z.object({ off: z.boolean() }).strict() : z.object({ on: z.boolean() }).strict()).parse(req.body ?? {}) as { off?: boolean; on?: boolean };
            // A run uses the phone right now: a setting that moves under it would change what it does.
            await ctx.assertNoActiveJob(id);
            const row = latestMobileRow(repo, id);
            if (!row?.mobile) throw new HttpError(409, "Add the phone app under Mobile app first.");
            const { adb, d, setup } = await phoneFor(serial);
            const call = (args: string[]) => setup.setupCall(args);
            const before = await checkOne(adb, d, row.mobile);
            try {
                if (path === "animations" && body.off) {
                    const saved = await turnAnimationsOff(call, before.maker);
                    // Values that were already 0 are not worth keeping: the undo then goes back to Android's default.
                    updateMobileTarget(repo, id, (cur) => withSaved(cur, serial, "animations", cur.phoneSetup?.animations?.[serial] ?? saved));
                } else if (path === "animations") {
                    await restoreAnimations(call, before.maker, row.mobile.phoneSetup?.animations?.[serial]);
                    updateMobileTarget(repo, id, (cur) => withSaved(cur, serial, "animations", undefined));
                } else if (body.on) {
                    const saved = await keepScreenOn(call, before.maker);
                    updateMobileTarget(repo, id, (cur) => withSaved(cur, serial, "stayAwake", cur.phoneSetup?.stayAwake?.[serial] ?? saved));
                } else {
                    await restoreScreenOn(call, before.maker, row.mobile.phoneSetup?.stayAwake?.[serial]);
                    updateMobileTarget(repo, id, (cur) => withSaved(cur, serial, "stayAwake", undefined));
                }
            } catch (e) {
                if (e instanceof HttpError) throw e;
                throw new HttpError(409, e instanceof AdbError ? e.message : e instanceof Error ? e.message : String(e));
            }
            return { phone: await checkOne(adb, d, latestMobileRow(repo, id)?.mobile) };
        });
    changeRoute("animations");
    changeRoute("stay-awake");

    // ── a person's answer while an exploration waits ─────────────────────────

    const jobOf = (projectId: string, jobId: string) => {
        ctx.project(projectId);
        const job = repo.getJob(jobId);
        if (!job || job.projectId !== projectId) throw new HttpError(404, "Job not found");
        return job;
    };

    app.get("/api/projects/:id/jobs/:jobId/phone-sign-in", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        jobOf(id, jobId);
        return { open: openQuestion(repo.db, jobId) ?? null };
    });

    app.post("/api/projects/:id/jobs/:jobId/phone-sign-in", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        jobOf(id, jobId);
        const body = z.object({ choice: z.enum(["continue", "skip"]) }).strict().parse(req.body ?? {});
        answerQuestion(repo, jobId, body.choice);
        return { answered: body.choice };
    });
}
