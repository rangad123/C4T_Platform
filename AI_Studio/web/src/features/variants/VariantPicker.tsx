import { useConfig } from "../../lib/hooks";
import { VARIANT_UI } from "./variants";
import "./variants.css";

/**
 * Checkboxes for the extra browsers and screen sizes. A browser that is not installed on the server is shown
 * with the reason and cannot be picked, so nobody waits for a check that cannot run.
 */
export function VariantPicker({ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
    const config = useConfig();
    return (
        <fieldset className="variant-picker">
            <legend className="sr-only">Browsers and screen sizes</legend>
            {VARIANT_UI.map((v) => {
                const info = config?.variants?.find((x) => x.id === v.id);
                const unavailable = info ? !info.available : false;
                return (
                    <label className="check" key={v.id} aria-disabled={unavailable || disabled || undefined}>
                        <input
                            type="checkbox"
                            checked={value.includes(v.id) && !unavailable}
                            disabled={unavailable || disabled}
                            onChange={(e) => onChange(e.target.checked ? [...value, v.id] : value.filter((x) => x !== v.id))}
                        />
                        <span>
                            <span className="title">{v.label}</span>
                            <span className="hint">{unavailable ? `Not available here. ${info?.reason ?? ""}` : v.hint}</span>
                        </span>
                    </label>
                );
            })}
        </fieldset>
    );
}
