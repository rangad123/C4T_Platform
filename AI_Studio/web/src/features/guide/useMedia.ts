import { useEffect, useState } from "react";

/** True while the screen matches a media query (re-read when the window changes). Starts from the real answer, so there is no flash. */
export function useMedia(query: string): boolean {
    const get = () => (typeof matchMedia === "function" ? matchMedia(query).matches : false);
    const [on, setOn] = useState(get);
    useEffect(() => {
        if (typeof matchMedia !== "function") return;
        const m = matchMedia(query);
        const change = () => setOn(m.matches);
        change();
        m.addEventListener("change", change);
        return () => m.removeEventListener("change", change);
    }, [query]);
    return on;
}
