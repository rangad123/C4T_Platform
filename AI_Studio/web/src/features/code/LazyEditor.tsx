import { lazy, Suspense, forwardRef } from "react";
import { Skeleton } from "../../components/ui";
import type { EditorHandle } from "./CodeEditor";

/** CodeMirror is a separate chunk: it is requested only when a page that shows an editor opens. */
const Editor = lazy(() => import("./CodeEditor"));

export type { EditorHandle };
type EditorProps = Parameters<typeof import("./CodeEditor").default>[0];

export const LazyEditor = forwardRef<EditorHandle, EditorProps>(function LazyEditor(props, ref) {
    return (
        <Suspense
            fallback={
                <div className="code-cm-loading" aria-busy="true" aria-label="Loading the editor">
                    <Skeleton w="30%" h={14} />
                    <Skeleton w="70%" h={14} />
                    <Skeleton w="55%" h={14} />
                    <Skeleton w="62%" h={14} />
                </div>
            }
        >
            <Editor ref={ref} {...props} />
        </Suspense>
    );
});
