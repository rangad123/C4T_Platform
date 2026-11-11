import "./modal.css";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type FormEvent, type ReactNode, type RefObject } from "react";

/**
 * A real modal dialog: keyboard stays inside and Escape closes it. The first field or button in `children`, or the one with data-autofocus, gets focus.
 * With `onSubmit` the body is a form, so Enter submits it.
 * Escape closes it at once (close() gives the focus back) and calls onClose in the same event: the browser's own "close" event comes a task
 * later, and a page that is already usable again must not see the dialog vanish after a click that reopened it.
 */
export function Modal({
    title,
    titleId,
    onClose,
    children,
    wide,
    foot,
    icon: Icon,
    onSubmit,
    className,
    testId,
    dialogRef,
}: {
    title: string;
    titleId: string;
    onClose: () => void;
    children: ReactNode;
    wide?: boolean;
    foot?: ReactNode;
    icon?: LucideIcon;
    onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
    /** Extra class for a dialog's own width or inner rules. */
    className?: string;
    testId?: string;
    dialogRef?: RefObject<HTMLDialogElement>;
}) {
    const own = useRef<HTMLDialogElement>(null);
    const ref = dialogRef ?? own;
    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        const target = d?.querySelector<HTMLElement>("[data-autofocus]") ?? d?.querySelector<HTMLElement>("input, select, textarea, button");
        target?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const heading = (
        <h2 className="t-section" id={titleId}>
            {title}
        </h2>
    );
    const inner = (
        <>
            {Icon ? (
                <div className="row">
                    <Icon size={18} aria-hidden />
                    {heading}
                </div>
            ) : (
                heading
            )}
            {children}
            {foot && <div className="foot">{foot}</div>}
        </>
    );
    return (
        <dialog
            ref={ref}
            className={`dialog${wide ? " is-wide" : ""}${className ? ` ${className}` : ""}`}
            aria-labelledby={titleId}
            onClose={onClose}
            onCancel={(e) => {
                e.preventDefault();
                ref.current?.close();
                onClose();
            }}
            data-testid={testId}
        >
            {onSubmit ? (
                <form className="inner" onSubmit={onSubmit} noValidate>
                    {inner}
                </form>
            ) : (
                <div className="inner">{inner}</div>
            )}
        </dialog>
    );
}
