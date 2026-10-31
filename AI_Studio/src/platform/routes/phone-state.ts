/**
 * The phone options of Setup > Mobile app that need the phone itself (engine/mobile/state):
 *   GET /api/projects/:id/mobile-app/permissions   the runtime permissions the project's app asks for, read from a phone connected to THIS computer
 *                                                  (`dumpsys package <the configured package>`), for the "Grant these permissions" checklist.
 * When no phone is connected here (or the project's phones are on a runner), the answer says so and the person can type the names instead.
 */
import { Adb } from "../../engine/mobile/device/adb.js";
import { parseRequestedPermissions } from "../../engine/mobile/state/permissions.js";
import { MobileTargetSchema } from "../../engine/mobile/target.js";
import type { RouteCtx } from "./types.js";

const NO_PHONE = "No phone or emulator is connected to the computer that runs the platform, so the app's permissions can't be read. Type the permission names instead (for example android.permission.CAMERA).";

export function registerPhoneStateRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    app.get("/api/projects/:id/mobile-app/permissions", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const parsed = MobileTargetSchema.safeParse(repo.getLatestApplicationPublic(id)?.config?.mobile);
        const pkg = parsed.success ? parsed.data.appPackage : undefined;
        if (!pkg) return { available: false, reason: "Add the app's package name first.", permissions: [] };
        const adb = Adb.locate({ timeoutMs: 15_000 });
        if (!adb) return { available: false, reason: NO_PHONE, permissions: [] };
        try {
            const ready = (await adb.devices()).find((d) => d.state === "device");
            if (!ready) return { available: false, reason: NO_PHONE, permissions: [] };
            const dev = adb.forSerial(ready.serial);
            if (!(await dev.hasPackage(pkg))) return { available: false, reason: `The app ${pkg} is not installed on the connected phone, so its permissions can't be read. Type the permission names instead.`, permissions: [] };
            const permissions = parseRequestedPermissions(await dev.forPreparation().packageDump(pkg));
            return { available: true, permissions };
        } catch {
            return { available: false, reason: NO_PHONE, permissions: [] };
        }
    });
}
