import type { Block, IssueDraft } from "./content.js";
import { trackerRequest, TrackerError } from "./http.js";
import type { CreatedIssue, IntegrationConfig, IssueProvider } from "./types.js";

type Cfg = Extract<IntegrationConfig, { kind: "notion" }>;

/** The API version the request shapes below were written for. */
export const NOTION_VERSION = "2022-06-28";
/** Notion rejects a rich-text piece longer than this, and a request with more child blocks than the second limit. */
export const NOTION_TEXT_LIMIT = 2000;
export const NOTION_MAX_BLOCKS = 100;

type RichText = { type: "text"; text: { content: string; link?: { url: string } } };
export type NotionBlock = Record<string, unknown>;

/**
 * Plain text as Notion rich text, in pieces of at most 2000 characters. Notion reads `content` as literal text (nothing in it
 * is interpreted as markup), so there is nothing to escape: what the test said is what the page shows.
 */
export function richText(text: string, link?: string): RichText[] {
    const clean = text.replace(/\u0000/g, "");
    const pieces: RichText[] = [];
    // Pieces are measured in UTF-16 units (what the limit counts) and cut between code points, never inside a surrogate pair.
    let current = "";
    const flush = () => {
        if (current) pieces.push({ type: "text", text: { content: current, ...(link ? { link: { url: link } } : {}) } });
        current = "";
    };
    for (const ch of clean) {
        if (current.length + ch.length > NOTION_TEXT_LIMIT) flush();
        current += ch;
    }
    flush();
    return pieces;
}

const block = (type: string, rich: RichText[], extra: Record<string, unknown> = {}): NotionBlock => ({ object: "block", type, [type]: { rich_text: rich, ...extra } });

/** The issue text as Notion blocks: headings, paragraphs, bullet and numbered items, a code block and a link. At most 100. */
export function toNotionBlocks(blocks: Block[]): NotionBlock[] {
    const out: NotionBlock[] = [];
    for (const b of blocks) {
        switch (b.t) {
            case "heading":
                out.push(block("heading_3", richText(b.text)));
                break;
            case "paragraph":
                out.push(block("paragraph", richText(b.text)));
                break;
            case "list":
                for (const item of b.items) out.push(block(b.ordered ? "numbered_list_item" : "bulleted_list_item", richText(item.replace(/\n/g, " "))));
                break;
            case "code":
                out.push(block("code", richText(b.text), { language: "plain text" }));
                break;
            case "link":
                out.push(block("paragraph", richText(b.label, /^https?:\/\//i.test(b.url) ? b.url : undefined)));
                break;
        }
    }
    if (out.length <= NOTION_MAX_BLOCKS) return out;
    // Never likely (an issue is a few dozen blocks), but a page must not be refused for being long.
    return [...out.slice(0, NOTION_MAX_BLOCKS - 1), block("paragraph", richText("The rest of the details are in the AI Testing Platform."))];
}

/** Notion words for what went wrong, in place of the generic tracker wording. */
function notionError(e: unknown): never {
    if (!(e instanceof TrackerError)) throw e;
    switch (e.upstreamStatus) {
        case 401:
            throw new TrackerError("unauthorized", "Notion didn’t accept the token. Check that it is the integration’s secret and has not been removed.", 401);
        case 403:
            throw new TrackerError("forbidden", "Notion accepted the token but the integration may not do this. In Notion, give the integration “Insert content” access (Capabilities).", 403);
        case 404:
            throw new TrackerError("not_found", "Notion can’t see that database. Open the database in Notion, choose “Connections” and share it with your integration.", 404);
        default:
            throw e;
    }
}

/** Notion (a page per issue in a database; API version 2022-06-28). */
export class NotionProvider implements IssueProvider {
    constructor(
        private readonly cfg: Cfg,
        private readonly token: string,
    ) {}

    private call(method: "GET" | "POST", path: string, body?: unknown) {
        const base = (this.cfg.apiUrl ?? "https://api.notion.com").replace(/\/+$/, "");
        return trackerRequest({
            method,
            url: `${base}${path}`,
            authorization: `Bearer ${this.token}`,
            headers: { "notion-version": NOTION_VERSION },
            body,
            service: "Notion",
        }).catch(notionError);
    }

    async verify(): Promise<string> {
        const { json } = await this.call("GET", `/v1/databases/${encodeURIComponent(this.cfg.databaseId)}`);
        const db = json as { title?: Array<{ plain_text?: string }>; properties?: Record<string, { type?: string }> } | undefined;
        const props = db?.properties ?? {};
        const name = db?.title?.map((t) => t.plain_text ?? "").join("").trim();
        const wanted = props[this.cfg.titleProperty];
        const real = Object.entries(props).find(([, p]) => p.type === "title")?.[0];
        if (!wanted) {
            throw new TrackerError("rejected", `That database has no column called “${this.cfg.titleProperty}”.${real ? ` Its title column is “${real}”: use that name.` : ""}`);
        }
        if (wanted.type !== "title") {
            throw new TrackerError("rejected", `“${this.cfg.titleProperty}” is not the title column of that database.${real ? ` Its title column is “${real}”: use that name.` : ""}`);
        }
        return `Connected to the Notion database${name ? ` “${name}”` : ""}.`;
    }

    async createIssue(draft: IssueDraft): Promise<CreatedIssue> {
        const { json } = await this.call("POST", "/v1/pages", {
            parent: { database_id: this.cfg.databaseId },
            properties: { [this.cfg.titleProperty]: { title: richText(draft.title.slice(0, NOTION_TEXT_LIMIT)) } },
            children: toNotionBlocks(draft.blocks),
        });
        const page = json as { id?: string; url?: string } | undefined;
        if (!page?.id || !page.url) throw new TrackerError("rejected", "Notion accepted the request but did not return the new page.");
        // Only a web address is kept as a link.
        if (!/^https?:\/\//i.test(page.url)) throw new TrackerError("rejected", "Notion returned a page address that is not a web link.");
        return { externalId: "page", url: page.url };
    }
}
