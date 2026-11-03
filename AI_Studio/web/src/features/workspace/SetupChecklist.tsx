import { CheckCircle2, Circle } from "lucide-react";
import { ApiError } from "../../api";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";

interface CheckItem {
    key: string;
    ok: boolean;
    text: string;
}

/** Where each setup item is fixed (keys agreed with the server's GET /api/projects/:id/setup-check). */
const FIX: Record<string, (id: string) => { href: string; label: string }> = {
    "web-address": (id) => ({ href: routes.projectSettings(id, "environments"), label: "Open Environments" }),
    "android-app": (id) => ({ href: routes.projectSettings(id, "mobile"), label: "Open Mobile app" }),
    "ios-app": (id) => ({ href: routes.projectSettings(id, "mobile"), label: "Open Mobile app" }),
    // Runners are machine-level (round 37): the project's runners are on the Runners page.
    "ios-runner": (id) => ({ href: routes.runners(id), label: "Open Runners" }),
    runner: (id) => ({ href: routes.runners(id), label: "Open Runners" }),
    "ai-model": () => ({ href: routes.settings, label: "Open Settings" }),
};

/**
 * What the project still needs before its platforms and testing modes can work (story US-010: steps skipped at creation show here).
 * Warnings, never blocks: a run that cannot happen is refused later with its own reason. Hidden when everything is set, and on an
 * older server that has no check.
 */
export function SetupChecklist({ id }: { id: string }) {
    const check = useFetch<{ items: CheckItem[] }>(`/projects/${id}/setup-check`);
    if (check.loading || check.error) {
        // A server without the check (404) shows nothing; another failure is not worth a banner on the dashboard.
        if (check.error && !(check.error instanceof ApiError && check.error.status === 404)) console.warn("setup check:", check.error.message);
        return null;
    }
    const items = check.data?.items ?? [];
    if (items.length === 0 || items.every((i) => i.ok)) return null;
    return (
        <section className="card card-pad stack-sm" aria-labelledby="setup-check-title" data-testid="setup-checklist">
            <h2 className="t-section" id="setup-check-title">
                Still to set up
            </h2>
            <ul className="setup-check">
                {items.map((i) => {
                    const fix = !i.ok ? FIX[i.key]?.(id) : undefined;
                    return (
                        <li key={i.key} className={i.ok ? "done" : undefined}>
                            {i.ok ? <CheckCircle2 size={18} aria-hidden className="ok" /> : <Circle size={18} aria-hidden />}
                            <span className="sr-only">{i.ok ? "Done: " : "To do: "}</span>
                            <span>{i.text}</span>
                            {fix && <a href={fix.href}>{fix.label}</a>}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
