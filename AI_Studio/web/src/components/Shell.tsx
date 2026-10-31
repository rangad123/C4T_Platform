import { ChevronRight, Folder, FolderKanban, LayoutDashboard, Menu, Server, Settings, ShieldCheck, Sparkles, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import crowd4testMark from "../assets/crowd4test-mark.png";
import { useEmbedded } from "../lib/embedded";
import { useConfig } from "../lib/hooks";
import { HelpButton, HelpNavItem } from "../features/guide/HelpButton";
import { useHelp } from "../features/guide/HelpContext";
import { DOCK_QUERY, HelpPanel } from "../features/guide/HelpPanel";
import { useMedia } from "../features/guide/useMedia";
import { routes } from "../lib/router";
import { Button } from "./ui";
import { AccountChip } from "../features/auth/AccountChip";
import { sec, useSecurityStatus } from "../features/security/security";
import { SIDE_WORDS, sideOf, useCan } from "../features/auth/permissions";
import { useAuth } from "../features/auth/auth";

export interface PageMeta {
    crumbs: Array<{ label: string; href?: string }>;
    /** Which top-level destination is current (everything inside a project counts as "projects"). */
    nav: "dashboard" | "projects" | "develop" | "folders" | "runners" | "settings" | "guide" | "security" | "profile";
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
    const config = useConfig();
    const security = useSecurityStatus();
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
                    {(can("ai_studio.tests.write") || can("ai_studio.tests.generate")) && item(routes.develop, "Test development", Sparkles, "develop", "nav-develop")}
                    {item(routes.folders, "Folders", Folder, "folders", "nav-folders")}
                    {can("ai_studio.runners.manage") && (
                        <>
                            <div className="nav-label">Operations</div>
                            {item(routes.allRunners, "Runners", Server, "runners", "nav-runners")}
                        </>
                    )}
                    {security?.enabled && can("ai_studio.security.use") && (
                        <>
                            <div className="nav-label">Security</div>
                            {item(sec.home, "Security assessment", ShieldCheck, "security", "nav-security")}
                        </>
                    )}
                    <div className="nav-label">System</div>
                    {(can("ai_studio.platform.settings") || can("ai_studio.usage.view")) && item(routes.settings, "Settings", Settings, "settings", "nav-settings")}
                    <HelpNavItem />
                    <div className="sidebar-foot">
                        <AccountChip />
                        {/* The AI's state; it opens Settings only for people who may change it. */}
                        {(() => {
                            const body = (
                                <>
                                    <span className={`dot ${config?.llm.configured ? "ok" : "off"}`} />
                                    {config ? (config.llm.configured ? "AI connected" : "AI not set up") : "Checking AI…"}
                                </>
                            );
                            const title = config ? `${config.llm.provider} · ${config.llm.model}` : undefined;
                            return can("ai_studio.platform.settings") ? (
                                <a className="ai-chip" href={routes.settings} title={title}>
                                    {body}
                                </a>
                            ) : (
                                <span className="ai-chip" title={title}>
                                    {body}
                                </span>
                            );
                        })()}
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
