import { SlidersHorizontal } from "lucide-react";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { settingsSentence, type FrameworkSettingsAnswer } from "./frameworks";
import "./frameworks.css";

/**
 * One quiet line on the Tests page when the project changed how its frameworks run ("API tests are turned off, web tests stop after
 * 120 s"), with a link to change it. A project that never touched the settings, or a server that does not answer, shows nothing.
 */
export function FrameworksLine({ projectId }: { projectId: string }) {
    const settings = useFetch<FrameworkSettingsAnswer>(`/projects/${projectId}/framework-settings`);
    const d = settings.data;
    if (!d) return null;
    const text = settingsSentence(d.settings, d.defaults);
    if (!text) return null;
    return (
        <p className="fw-line t-secondary" data-testid="frameworks-line">
            <SlidersHorizontal size={16} aria-hidden />
            <span>{text}.</span>
            <a href={routes.setup(projectId, "frameworks")}>Change</a>
        </p>
    );
}
