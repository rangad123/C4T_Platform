import "./code.css";
import { useEffect, useRef, type ReactNode } from "react";

/** A real modal dialog: keyboard stays inside and Escape closes it. The first button in `children` or the one with data-autofocus gets focus. */
export function Modal({ title, titleId, onClose, children, wide, foot }: { title: string; titleId: string; onClose: () => void; children: ReactNode; wide?: boolean; foot?: ReactNode }) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        const target = d?.querySelector<HTMLElement>("[data-autofocus]") ?? d?.querySelector<HTMLElement>("input, select, textarea, button");
        target?.focus();
    }, []);
    return (
        <dialog ref={ref} className={`code-dialog${wide ? " is-wide" : ""}`} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
            <div className="inner">
                <h2 className="t-section" id={titleId}>
                    {title}
                </h2>
                {children}
                {foot && <div className="foot">{foot}</div>}
            </div>
        </dialog>
    );
}
