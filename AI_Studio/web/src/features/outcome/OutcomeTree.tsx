import { ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parentNode, visibleNodes, type TreeNode } from "./outcome";

/**
 * The application as one tree of pages (founder 2026-11-19 P3, R8): each node is a page with its title, address and the number of test
 * cases that start on it; a node's children are the pages first reached from it. It is an ARIA tree (WAI-ARIA APG "tree view"): one tab
 * stop, Up and Down move, Right opens a node or goes to its first child, Left closes it or goes to its parent, Home and End jump, Enter
 * and Space select. Selecting a node shows its test cases (CaseOutcome.tsx); selecting it again shows every case.
 */
export function OutcomeTree({ roots, counts, selected, onSelect, label }: { roots: TreeNode[]; counts: ReadonlyMap<string, number>; selected: string | null; onSelect: (path: string | null) => void; label: string }) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(roots.filter((r) => r.children.length).map((r) => r.path)));
    const visible = useMemo(() => visibleNodes(roots, expanded), [roots, expanded]);
    const [focused, setFocused] = useState<string | null>(null);
    const items = useRef(new Map<string, HTMLLIElement>());
    const moved = useRef(false);
    const base = useId();
    // Element ids by position in the whole tree (a page path is not a safe id).
    const ids = useMemo(() => {
        const m = new Map<string, string>();
        const walk = (list: TreeNode[]) => list.forEach((n) => (m.set(n.path, `${base}-${m.size}`), walk(n.children)));
        walk(roots);
        return m;
    }, [roots, base]);

    // The one tab stop: the focused node, else the selected one, else the first.
    const stop = visible.some((n) => n.path === focused) ? focused : visible.some((n) => n.path === selected) ? selected : (visible[0]?.path ?? null);

    useEffect(() => {
        if (moved.current && stop) items.current.get(stop)?.focus();
        moved.current = false;
    }, [stop, visible]);

    const move = (path: string | undefined) => {
        if (!path) return;
        moved.current = true;
        setFocused(path);
    };
    const toggle = (path: string, open?: boolean) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (open ?? !next.has(path)) next.add(path);
            else next.delete(path);
            return next;
        });
    const choose = (path: string) => onSelect(selected === path ? null : path);

    const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
        const at = visible.findIndex((n) => n.path === stop);
        const here = visible[at];
        if (!here) return;
        const open = expanded.has(here.path);
        let handled = true;
        switch (e.key) {
            case "ArrowDown":
                move(visible[at + 1]?.path);
                break;
            case "ArrowUp":
                move(visible[at - 1]?.path);
                break;
            case "Home":
                move(visible[0]?.path);
                break;
            case "End":
                move(visible[visible.length - 1]?.path);
                break;
            case "ArrowRight":
                if (here.children.length && !open) toggle(here.path, true);
                else if (here.children.length) move(here.children[0].path);
                break;
            case "ArrowLeft":
                if (here.children.length && open) toggle(here.path, false);
                else move(parentNode(roots, here.path)?.path);
                break;
            case "Enter":
            case " ":
                choose(here.path);
                break;
            default:
                handled = false;
        }
        if (handled) e.preventDefault();
    };

    const render = (list: TreeNode[]) =>
        list.map((n, i) => {
            const has = n.children.length > 0;
            const open = has && expanded.has(n.path);
            const count = counts.get(n.path) ?? 0;
            const id = ids.get(n.path);
            return (
                <li
                    key={n.path}
                    ref={(el) => {
                        if (el) items.current.set(n.path, el);
                        else items.current.delete(n.path);
                    }}
                    role="treeitem"
                    aria-level={n.level}
                    aria-setsize={list.length}
                    aria-posinset={i + 1}
                    aria-expanded={has ? open : undefined}
                    aria-selected={selected === n.path}
                    aria-labelledby={id}
                    tabIndex={stop === n.path ? 0 : -1}
                    className="ot-item"
                    data-path={n.path}
                    onFocus={(e) => {
                        if (e.target === e.currentTarget) setFocused(n.path);
                    }}
                >
                    <div
                        className="ot-row"
                        onClick={() => {
                            setFocused(n.path);
                            choose(n.path);
                        }}
                    >
                        {has ? (
                            <span
                                className="ot-chev"
                                aria-hidden
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setFocused(n.path);
                                    toggle(n.path);
                                }}
                            >
                                <ChevronRight size={16} />
                            </span>
                        ) : (
                            <span className="ot-chev is-leaf" aria-hidden />
                        )}
                        <span className="ot-text" id={id}>
                            <span className="ot-title">{n.title}</span>
                            {n.page && <span className="ot-path">{n.page}</span>}
                            <span className="sr-only">, {count === 1 ? "1 test case" : `${count} test cases`}</span>
                        </span>
                        <span className={`ot-count${count ? "" : " is-zero"}`} aria-hidden>
                            {count}
                        </span>
                    </div>
                    {has && open && (
                        <ul role="group" className="ot-group">
                            {render(n.children)}
                        </ul>
                    )}
                </li>
            );
        });

    return (
        <ul role="tree" aria-label={label} className="ot-tree" onKeyDown={onKeyDown}>
            {render(roots)}
        </ul>
    );
}
