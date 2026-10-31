/**
 * Where a tooltip panel goes: next to its element on the asked side, flipped to the other side when it does not fit, then shifted
 * along the edge so it stays inside the window. Pure (no DOM), so tests/tooltips-unit.test.ts checks it in Node.
 */
export type Placement = "top" | "bottom" | "left" | "right";

/** Space between the element and the panel, and the least space between the panel and the window's edge (px). */
const GAP = 8;
const EDGE = 8;

export interface Box {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

/**
 * Fixed-position coordinates for a panel of `panel` size next to `anchor` in a window of `view` size. `strict` keeps it on the asked
 * axis (a tip beside a menu entry must never cover the menu); `fits` is false when no allowed side has room.
 */
export function placePanel(anchor: Box, panel: { width: number; height: number }, want: Placement, view: { width: number; height: number }, strict = false): { top: number; left: number; placement: Placement; fits: boolean } {
    const fits = (p: Placement) =>
        p === "top" ? anchor.top - GAP - panel.height >= EDGE
        : p === "bottom" ? anchor.bottom + GAP + panel.height <= view.height - EDGE
        : p === "left" ? anchor.left - GAP - panel.width >= EDGE
        : anchor.right + GAP + panel.width <= view.width - EDGE;
    const opposite: Record<Placement, Placement> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    // Side placements fall back to top/bottom on a narrow screen rather than squeezing.
    const order: Placement[] = [want, opposite[want], ...(strict ? [] : (["top", "bottom", "right", "left"] as Placement[]).filter((p) => p !== want && p !== opposite[want]))];
    const found = order.find(fits);
    const placement = found ?? want;
    let top: number;
    let left: number;
    if (placement === "top" || placement === "bottom") {
        top = placement === "top" ? anchor.top - GAP - panel.height : anchor.bottom + GAP;
        left = anchor.left + anchor.width / 2 - panel.width / 2;
    } else {
        left = placement === "left" ? anchor.left - GAP - panel.width : anchor.right + GAP;
        top = anchor.top + anchor.height / 2 - panel.height / 2;
    }
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, view.width - EDGE - panel.width));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, view.height - EDGE - panel.height));
    return { top: Math.round(top), left: Math.round(left), placement, fits: found !== undefined };
}
