import { ListChecks, X } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { plural } from "../../lib/format";
import "./runs.css";

/** Choosing tests in a list to run: a mode that adds a checkbox to every row and a bar that counts what is chosen. */
export function useTestSelection() {
    const [selecting, setSelecting] = useState(false);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const toggle = useCallback((id: string) => setPicked((p) => {
        const n = new Set(p);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
    }), []);
    const set = useCallback((ids: string[]) => setPicked(new Set(ids)), []);
    const stop = useCallback(() => {
        setSelecting(false);
        setPicked(new Set());
    }, []);
    return { selecting, setSelecting, picked, toggle, set, stop };
}

export type TestSelection = ReturnType<typeof useTestSelection>;

/** The button that switches the mode on or off. */
export function SelectToggle({ selection }: { selection: TestSelection }) {
    return (
        <Button variant="ghost" icon={ListChecks} aria-pressed={selection.selecting} onClick={() => (selection.selecting ? selection.stop() : selection.setSelecting(true))}>
            Select scripts
        </Button>
    );
}

/** One row of the list while choosing: a checkbox (with the test's name) beside the row, which stays a link. */
export function SelectableRow({ id, title, selection, children }: { id: string; title: string; selection: TestSelection; children: ReactNode }) {
    return (
        <div className="run-pick-row">
            <label className="run-pick">
                <input type="checkbox" checked={selection.picked.has(id)} onChange={() => selection.toggle(id)} aria-label={`Select ${title}`} />
            </label>
            <div className="grow">{children}</div>
        </div>
    );
}

/** "3 tests selected": what is chosen, quick ways to choose more, and the Run control for exactly these tests. */
export function SelectionBar({ selection, shownIds, run }: { selection: TestSelection; shownIds: string[]; run: ReactNode }) {
    const n = selection.picked.size;
    const allShown = shownIds.length > 0 && shownIds.every((id) => selection.picked.has(id));
    return (
        <div className="run-selbar" role="region" aria-label="Selected scripts">
            <p className="t-card" role="status">
                {n === 0 ? "No scripts selected" : `${plural(n, "script")} selected`}
            </p>
            <Button variant="ghost" disabled={shownIds.length === 0} onClick={() => selection.set(allShown ? [...selection.picked].filter((id) => !shownIds.includes(id)) : [...new Set([...selection.picked, ...shownIds])])}>
                {allShown ? "Clear the shown scripts" : `Select the ${shownIds.length} shown`}
            </Button>
            <span className="spacer" />
            {run}
            <Button variant="ghost" icon={X} onClick={selection.stop}>
                Done
            </Button>
        </div>
    );
}
