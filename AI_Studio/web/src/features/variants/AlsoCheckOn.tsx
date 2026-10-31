import { Disclosure } from "../../components/ui";
import { VariantPicker } from "./VariantPicker";
import { VARIANT_UI, variantShort } from "./variants";
import "./variants.css";

/** "Also check on: Firefox · Safari · Phone · Tablet" in a new analysis's Advanced options. Collapsed and off by default. */
export function AlsoCheckOn({ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
    const names = (value.length ? value : VARIANT_UI.map((v) => v.id)).map(variantShort).join(" · ");
    return (
        <div className="stack-sm opt-group">
            <div>
                <div className="t-card">Other browsers and screen sizes</div>
                <p className="hint">Optional. Once your tests pass in Chrome, we repeat them on the browsers and screen sizes you choose and show where they break. Accessibility and visual checks aren’t repeated.</p>
            </div>
            <Disclosure label={`Also check on: ${names}`}>
                <VariantPicker value={value} onChange={onChange} disabled={disabled} />
            </Disclosure>
        </div>
    );
}
