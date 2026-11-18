import { ExternalLink, Play } from "lucide-react";
import { useId, useState } from "react";
import { artifactUrl } from "../../api";
import { Modal } from "../../components/Modal";
import { prunedNote } from "../storage/storage";
import type { RunProof as Proof } from "./run-text";

const shotWords = (p: Proof): string => (p.moment === "failure" ? "Screenshot at the failing step" : "Screenshot at the end of the test");

/**
 * What a test did in a run, as the run kept it: its screenshots as thumbnails that open larger, and its recording, which plays in the
 * same dialog with the browser's own controls. A file the retention policy removed says so instead.
 */
export function RunProof({ proof, title }: { proof: Proof[]; title: string }) {
    const [open, setOpen] = useState<Proof | null>(null);
    const titleId = useId();
    const kept = proof.filter((p) => !p.removedAt);
    const removed = proof.filter((p) => p.removedAt);
    const shots = kept.filter((p) => p.kind === "screenshot");
    const video = kept.find((p) => p.kind === "video");
    if (!proof.length) return null;
    const label = (p: Proof, i: number) => (p.kind === "video" ? "Recording of the test" : `${shotWords(p)}${shots.length > 1 ? ` (${i + 1} of ${shots.length})` : ""}`);
    return (
        <div className="run-proof" role="group" aria-label={`What ${title} did`} data-testid="run-proof">
            {shots.map((p, i) => (
                <button key={p.id} type="button" className="run-proof-thumb" aria-label={`Open the ${label(p, i).toLowerCase()}`} onClick={() => setOpen(p)}>
                    <img src={artifactUrl(p.id)} alt="" loading="lazy" />
                </button>
            ))}
            {video && (
                <button type="button" className="btn btn-sm run-proof-play" onClick={() => setOpen(video)}>
                    <Play size={16} aria-hidden />
                    Watch the recording
                </button>
            )}
            {removed.map((p) => (
                <span key={p.id} className="t-meta run-proof-gone">
                    {prunedNote(p.kind, p.removedAt!)}
                </span>
            ))}
            {open && (
                <Modal
                    title={open.kind === "video" ? `Recording: ${title}` : `${shotWords(open)}: ${title}`}
                    titleId={titleId}
                    onClose={() => setOpen(null)}
                    wide
                    className="run-proof-dialog"
                    foot={
                        <>
                            <a className="btn btn-ghost" href={artifactUrl(open.id)} target="_blank" rel="noreferrer">
                                <ExternalLink size={16} aria-hidden />
                                Open in a new tab
                            </a>
                            <button type="button" className="btn" data-autofocus onClick={() => setOpen(null)}>
                                Close
                            </button>
                        </>
                    }
                >
                    {open.kind === "video" ? (
                        <video src={artifactUrl(open.id)} controls preload="metadata" aria-label={`Recording of ${title}`} />
                    ) : (
                        <img src={artifactUrl(open.id)} alt={`${shotWords(open)} of ${title}`} />
                    )}
                </Modal>
            )}
        </div>
    );
}
