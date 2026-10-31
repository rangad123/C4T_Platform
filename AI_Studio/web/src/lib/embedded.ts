import { createContext, useContext } from "react";

/**
 * True while a page is shown as one section of a project hub (Library, Settings, Runs, Release).
 * The hub owns the page title, the tab bar and the breadcrumbs, so a section that was once a page of its own
 * keeps its content and drops those three things (see `PageHeader`, `ProjectTabs`, `usePage`, `useDocumentTitle`).
 */
export const EmbeddedContext = createContext(false);

export const useEmbedded = (): boolean => useContext(EmbeddedContext);
