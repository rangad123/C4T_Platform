import { Puzzle } from "lucide-react";
import { Badge, Callout } from "../../components/ui";
import { useConfig } from "../../lib/hooks";

const KIND_NAME: Record<string, string> = { web: "web", api: "API", mobile: "mobile", desktop: "desktop" };

/**
 * Frameworks that an adapter plug-in adds, shown under the built-in ones in the Frameworks section. Read only: a plug-in is turned on
 * or off by the person who runs the server (ALLOW_ADAPTER_PLUGINS, ADAPTER_PLUGINS), never from this page. Nothing shows while the
 * feature is unused, so the page looks exactly as it did before plug-ins existed.
 */
export function PluginFrameworks() {
    const config = useConfig();
    const status = config?.adapterPlugins;
    if (!status || (!status.requested && status.configured === 0 && status.loaded.length === 0 && status.problems.length === 0)) return null;
    const adapters = config?.adapters ?? [];
    const kindsOf = (id: string) => (adapters.find((a) => a.id === id)?.kinds ?? []).map((k) => KIND_NAME[k] ?? k).join(", ");

    return (
        <div className="stack-sm" data-testid="fw-plugins" role="group" aria-labelledby="fw-plugins-title">
            <h3 className="t-card" id="fw-plugins-title">
                Plug-in frameworks
            </h3>
            {status.reason && <Callout tone="warning">{status.reason}</Callout>}
            {status.problems.map((p) => (
                <Callout key={`${p.plugin}-${p.message}`} tone="danger" title={`${p.plugin} did not load`}>
                    {p.message} The rest of the platform works as usual.
                </Callout>
            ))}
            {status.enabled && status.loaded.length === 0 && status.problems.length === 0 && <p className="t-secondary">No plug-in is loaded. ADAPTER_PLUGINS on the server lists the ones to load.</p>}
            {status.loaded.map((pl) => (
                <ul className="fw-plugin-list" key={pl.name} aria-label={`${pl.name} ${pl.version}`}>
                    {pl.adapters.map((a) => (
                        <li className="fw-plugin" key={a.id} data-testid={`fw-plugin-${a.id}`}>
                            <Puzzle size={16} aria-hidden />
                            <span className="fw-plugin-main">
                                <span className="title">{a.label}</span>
                                <span className="hint">
                                    From the plug-in {pl.name} {pl.version}, runs {kindsOf(a.id) ? `${kindsOf(a.id)} tests ` : ""}on this server.
                                </span>
                            </span>
                            <Badge tone="brand">Plug-in</Badge>
                        </li>
                    ))}
                </ul>
            ))}
            {status.loaded.length > 0 && <p className="hint">Plug-ins are turned on and off by whoever runs the server, not from this page. Tests that use one run on the server only.</p>}
        </div>
    );
}
