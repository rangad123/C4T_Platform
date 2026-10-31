import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { Badge, Button, Callout, Skeleton } from "../../components/ui";
import { KIND_COLOUR, KINDS, sizeBar, STORAGE_KIND_LABELS, type PlatformStorage, type StorageKind, type Usage } from "./storage";
import "./storage.css";

/** The stacked bar and its legend: every segment is also named, with its size, so colour is never the only signal. */
export function UsageBar({ usage, label }: { usage: Usage; label: string }) {
  const bytes = Object.fromEntries(KINDS.map((k) => [k, usage.byKind[k]?.bytes ?? 0])) as Record<StorageKind, number>;
  const segments = sizeBar(bytes);
  if (segments.length === 0) return <p className="t-secondary">No files are stored yet.</p>;
  return (
    <div>
      <div className="st-bar" role="img" aria-label={label}>
        {segments.map((s) => (
          <i key={s.kind} style={{ width: `${s.percent}%`, background: KIND_COLOUR[s.kind] }} />
        ))}
      </div>
      <ul className="st-legend" aria-label="Files by kind">
        {segments.map((s) => (
          <li key={s.kind}>
            <span className="sw" style={{ background: KIND_COLOUR[s.kind] }} aria-hidden />
            <span>{STORAGE_KIND_LABELS[s.kind]}</span>
            <span className="size">{usage.byKind[s.kind].text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Settings: how much disk the platform uses, by kind of file and by project. */
export function StorageSettings() {
  const data = useFetch<PlatformStorage>("/storage");
  const d = data.data;
  return (
    <section className="card card-pad stack-sm" aria-label="Storage">
      <div className="row">
        <h2 className="t-section">Storage</h2>
        <span className="spacer" />
        {d?.platformDefaultDays ? <Badge tone="info">Old files removed after {d.platformDefaultDays} days by default</Badge> : null}
      </div>
      {data.loading ? (
        <>
          <Skeleton h={14} />
          <Skeleton h={80} />
        </>
      ) : data.error || !d ? (
        <Callout tone="warning" title="Could not load storage details" actions={<Button size="sm" onClick={() => void data.reload()}>Try again</Button>}>
          {friendlyError(data.error?.message ?? "").body}
        </Callout>
      ) : (
        <>
          <p className="t-secondary">
            Test files use <strong>{d.files.text}</strong> and the database uses <strong>{d.database.text}</strong>.
            {d.disk ? ` The disk has ${d.disk.freeText} free of ${d.disk.totalText}.` : ""}
            {d.truncated ? " This computer holds so many files that the total may be a little higher." : ""}
          </p>
          <UsageBar usage={d.files} label={`Test files by kind, ${d.files.text} in total`} />
          {d.projects.length > 0 ? (
            <table className="st-table">
              <caption className="t-meta" style={{ textAlign: "left", paddingBottom: 6 }}>Projects that use the most space</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" className="num">Used</th>
                  <th scope="col">Old files</th>
                </tr>
              </thead>
              <tbody>
                {d.projects.map((p) => (
                  <tr key={p.id}>
                    <td><a href={routes.project(p.id)}>{p.name}</a></td>
                    <td className="num">{p.text}</td>
                    <td>{p.retention?.enabled ? "Removed automatically" : "Kept"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="t-secondary">No project has stored files yet. They appear here after the first run.</p>
          )}
          <p className="t-meta">Open a project to remove old files automatically, or to download a backup of it.</p>
        </>
      )}
    </section>
  );
}
