import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { Modal } from "../../components/Modal";

/**
 * Leaving with unsaved changes asks first: a link inside the app opens a dialog, closing the tab shows the browser's own warning.
 * Returns the dialog to render and `allowLeaving()` for the moment right after a save.
 */
export function useLeaveGuard(dirty: boolean, stays?: (href: string) => boolean): { dialog: ReactNode; allowLeaving: () => void } {
    const staysRef = useRef(stays);
    staysRef.current = stays;
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const [href, setHref] = useState<string | null>(null);

    useEffect(() => {
        const before = (e: BeforeUnloadEvent) => {
            if (!dirtyRef.current) return;
            e.preventDefault();
            e.returnValue = "";
        };
        const click = (e: MouseEvent) => {
            if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = (e.target as Element | null)?.closest?.("a[href]");
            const target = a?.getAttribute("href");
            if (!target || !target.startsWith("#/") || target === location.hash || staysRef.current?.(target)) return;
            e.preventDefault();
            e.stopPropagation();
            setHref(target);
        };
        window.addEventListener("beforeunload", before);
        document.addEventListener("click", click, true);
        return () => {
            window.removeEventListener("beforeunload", before);
            document.removeEventListener("click", click, true);
        };
    }, []);

    const dialog = href ? (
        <Modal
            title="Leave without saving?"
            titleId="bld-leave-title"
            onClose={() => setHref(null)}
            foot={
                <>
                    <Button data-autofocus onClick={() => setHref(null)}>
                        Stay and keep editing
                    </Button>
                    <Button
                        variant="danger"
                        onClick={() => {
                            const go = href;
                            dirtyRef.current = false;
                            setHref(null);
                            location.hash = go.replace(/^#/, "");
                        }}
                    >
                        Leave and lose changes
                    </Button>
                </>
            }
        >
            <p className="t-secondary">You have changes to the steps that are not saved. If you leave now they are lost.</p>
        </Modal>
    ) : null;

    return {
        dialog,
        allowLeaving: () => {
            dirtyRef.current = false;
        },
    };
}
