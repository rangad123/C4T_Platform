import { useHelp } from "./HelpContext";

/**
 * The calm line on an empty page: "Not sure how this works? See how". It opens the matching topic in the Help panel (or a search for
 * `query` when that topic is not in the Guide), so a newcomer never has to leave the page to learn what it is for.
 */
export function SeeHow({ topic, query }: { topic: string; query?: string }) {
    const help = useHelp();
    return (
        <p className="see-how">
            Not sure how this works?{" "}
            <button type="button" className="btn-link" onClick={() => help.show({ topic, ...(query ? { query } : {}) })}>
                See how
            </button>
        </p>
    );
}
