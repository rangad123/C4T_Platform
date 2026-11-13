import { Bot, ChevronRight, FolderKanban, LayoutDashboard, Library, Menu, Plug, Settings, Sparkles, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import crowd4testMark from "../assets/crowd4test-mark.png";
import { useEmbedded } from "../lib/embedded";
import { HelpButton, HelpNavItem } from "../features/guide/HelpButton";
import { useHelp } from "../features/guide/HelpContext";
import { DOCK_QUERY, HelpPanel } from "../features/guide/HelpPanel";
import { useMedia } from "../features/guide/useMedia";
import { routes } from "../lib/router";
import { Button } from "./ui";
import { AccountChip } from "../features/auth/AccountChip";
import { SIDE_WORDS, sideOf, useCan } from "../features/auth/permissions";
import { useAuth } from "../features/auth/auth";
import { aiReadyOf, useMyAi } from "../features/aiconfig/aiconfig";

export interface PageMeta {
    crumbs: Array<{ label: string; href?: string }>;
    /** Which top-level destination is current (everything inside a project counts as "projects"). */
    nav: "dashboard" | "projects" | "agents" | "develop" | "libraries" | "integrations" | "settings" | "guide" | "security" | "profile";
}

const Ctx = createContext<(m: PageMeta) => void>(() => undefined);

/** Pages call this so the shell can render breadcrumbs and the right sidebar section. */
export function usePage(meta: PageMeta): void {
    const set = useContext(Ctx);
    const embedded = useEmbedded();
    const key = JSON.stringify(meta);
    // A section inside a hub (Test cases, Test scripts, Runs, Settings) leaves the breadcrumbs to the hub.
    useEffect(() => {
        if (!embedded) set(JSON.parse(key));
    }, [key, set, embedded]);
}

export function Shell({ children, routeKey }: { children: ReactNode; routeKey: string }) {
    const [meta, setMeta] = useState<PageMeta>({ crumbs: [], nav: "projects" });
    const [open, setOpen] = useState(false);
    const ai = useMyAi();
    const myAi = ai.data;
    // A refusal or an error is "not set up", never a sign that keeps checking.
    const aiReady = ai.error && !myAi ? false : aiReadyOf(myAi);
    const aiTitle = myAi?.openServer ? `${myAi.openServer.provider} · ${myAi.openServer.model}` : myAi?.chosen ? `${myAi.chosen.label} · ${myAi.chosen.model}` : undefined;
    const help = useHelp();
    // Wide screens keep the Help panel beside the page; the page makes room for it.
    const docked = useMedia(DOCK_QUERY) && help.open;
    useEffect(() => setOpen(false), [routeKey]);

    const item = (href: string, label: string, Icon: typeof Settings, nav: PageMeta["nav"], tour?: string) => (
        <a className="nav-item" href={href} aria-current={meta.nav === nav ? "page" : undefined} data-tour={tour}>
            <Icon size={18} aria-hidden />
            {label}
        </a>
    );

    const setter = useMemo(() => setMeta, []);
    const can = useCan();
    const side = sideOf(useAuth().state?.me);
    return (
        <Ctx.Provider value={setter}>
            <div className={`shell ${open ? "nav-open" : ""}${docked ? " help-docked" : ""}`}>
                <aside className="sidebar" aria-label="Main navigation">
                    <a className="brand" href={routes.dashboard} aria-label="Crowd4Test AI Studio dashboard">
                        <img className="brand-mark" src={crowd4testMark} alt="" width={24} height={24} />
                        AI Studio
                        {side !== "local" && <span className="brand-side">{SIDE_WORDS[side]}</span>}
                    </a>
                    {/* The global places (docs/product-restructure/INFORMATION_ARCHITECTURE.md). Each shows only with the feature it
                        needs; the server refuses regardless, so hiding is a convenience, not the boundary. */}
                    <div className="nav-label">Workspace</div>
                    {item(routes.dashboard, "Dashboard", LayoutDashboard, "dashboard", "nav-dashboard")}
                    {item(routes.home, "Projects", FolderKanban, "projects", "nav-projects")}
                    {/* Agents: read-level like Projects, so everyone who can see a project sees them. */}
                    {item(routes.agents, "Agents", Bot, "agents", "nav-agents")}
                    {(can("ai_studio.tests.write") || can("ai_studio.tests.generate")) && item(routes.develop, "Test development", Sparkles, "develop", "nav-develop")}
                    {item(routes.libraries, "Reusable libraries", Library, "libraries", "nav-libraries")}
                    {(can("ai_studio.ai_keys.manage") || can("ai_studio.project.settings")) && (
                        <>
                            <div className="nav-label">Operations</div>
                            {/* Round 45: no Runners place. Each person's runner is set up once in Settings (Your runner). */}
                            {/* Integrations: set up with "manage keys and connections", chosen per project with project settings. */}
                            {(can("ai_studio.ai_keys.manage") || can("ai_studio.project.settings")) && item(routes.integrations, "Integrations", Plug, "integrations", "nav-integrations")}
                        </>
                    )}
                    {/* Round 37: Security assessment is no longer in the left panel. Its pages stay: a project that includes it has
                        a Security assessment tab, and #/security still lists those projects. */}
                    <div className="nav-label">System</div>
                    {/* Settings: also for anyone who may run tests or use the AI: their runner and their AI keys are there. */}
                    {(can("ai_studio.platform.settings") || can("ai_studio.usage.view") || can("ai_studio.tests.run") || can("ai_studio.runners.manage") || can("ai_studio.tests.generate") || can("ai_studio.agent.run")) && item(routes.settings, "Settings", Settings, "settings", "nav-settings")}
                    <HelpNavItem />
                    <div className="sidebar-foot">
                        <AccountChip />
                        {/* The person's AI: their chosen key (Settings, AI keys), which every AI job they start uses. */}
                        <a className="ai-chip" href={routes.aiKeys} title={aiTitle} data-testid="ai-chip">
                            <span className={`dot ${aiReady ? "ok" : "off"}`} />
                            {aiReady === undefined ? "Checking AI…" : aiReady ? "AI connected" : "AI not set up"}
                        </a>
                    </div>
                </aside>
                <div className="scrim" onClick={() => setOpen(false)} />
                <div className="main">
                    <div className="topbar">
                        <Button className="menu-btn" variant="ghost" iconOnly icon={open ? X : Menu} aria-label="Toggle navigation" onClick={() => setOpen((o) => !o)} />
                        <nav className="crumbs" aria-label="Breadcrumb">
                            {meta.crumbs.map((c, i) => (
                                <span key={i} style={{ display: "contents" }}>
                                    {i > 0 && <ChevronRight size={14} className="sep" aria-hidden />}
                                    {c.href && i < meta.crumbs.length - 1 ? <a href={c.href}>{c.label}</a> : <span className={i === meta.crumbs.length - 1 ? "here truncate" : ""}>{c.label}</span>}
                                </span>
                            ))}
                        </nav>
                        <HelpButton />
                    </div>
                    <main className="content" id="content">
                        {children}
                    </main>
                </div>
            </div>
            <HelpPanel />
        </Ctx.Provider>
    );
}
