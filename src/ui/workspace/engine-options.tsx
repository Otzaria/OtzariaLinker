import { customKey, ENGINE_OPTION_SPECS, isEssential, isShown, MARKER_CHOICES, type FormValues, type OptionsCheck, type OptionSpec } from "../../linking/automatic/option-specs";
import type { EngineId } from "../../linking/automatic";
import { TypesHelpButton } from "../dialogs/types-help-dialog";
import { UnsupportedTypes } from "./type-options";

/*
 * The engine's settings, rendered from ENGINE_OPTION_SPECS. The form holds plain values; RunForm
 * turns them into engine options with toEngineOptions and refuses to start while `check.errors` is
 * not empty. ESSENTIAL options (the preset of "לפי תבנית", and its pattern while the preset is
 * "custom") are always shown, above the rest; the others only in advanced mode, folded.
 */
type OnChange = (key: string, value: string | number | boolean) => void;

/** a change that also clears the options the spec resets (a new preset drops an edited pattern) */
const changer = (spec: OptionSpec, onChange: OnChange): OnChange => (key, value) => {
  onChange(key, value);
  if (key === spec.key) for (const k of spec.resets ?? []) onChange(k, "");
};

export function EssentialOptions({ engine, values, check, onChange }: { engine: EngineId; values: FormValues; check: OptionsCheck; onChange: OnChange }) {
  const specs = ENGINE_OPTION_SPECS[engine].filter((s) => isEssential(s, values) && isShown(s, values));
  if (!specs.length) return null;
  return (
    <div class="builder" style="padding:0">
      {specs.map((spec) => (
        <Field key={`${engine}:${spec.key}`} spec={spec} values={values} error={check.errors[spec.key]} onChange={changer(spec, onChange)} />
      ))}
    </div>
  );
}

export function EngineOptions({ engine, values, check, onChange, onReset }: {
  engine: EngineId;
  values: FormValues;
  check: OptionsCheck;
  onChange: OnChange;
  onReset: () => void;
}) {
  const specs = ENGINE_OPTION_SPECS[engine].filter((s) => !isEssential(s, values) && isShown(s, values));
  if (!specs.length) return null;
  return (
    <details class="held engine-options" open={check.changed > 0 || Object.keys(check.errors).length > 0}>
      <summary>
        הגדרות השיטה{check.changed > 0 ? ` (${check.changed} שונו)` : ""}
      </summary>
      <div class="builder" style="padding:6px 0 0">
        {specs.map((spec) => (
          <Field key={`${engine}:${spec.key}`} spec={spec} values={values} error={check.errors[spec.key]} onChange={changer(spec, onChange)} />
        ))}
        {check.changed > 0 && (
          <button class="adv-link" onClick={onReset}>החזרת ברירות המחדל</button>
        )}
      </div>
    </details>
  );
}

/** A select's choices under their headings (V7 §3.6: a link type is a commentary or a link); a choice in no group comes first. */
function GroupedChoices({ choices, groups }: { choices: readonly (readonly [string, string])[]; groups: readonly (readonly [string, readonly string[]])[] }) {
  const label = new Map(choices);
  const grouped = new Set(groups.flatMap(([, v]) => v));
  return (
    <>
      {choices.filter(([v]) => !grouped.has(v)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      {groups.map(([g, values]) => (
        <optgroup key={g} label={g}>
          {values.map((v) => <option key={v} value={v}>{label.get(v) ?? v}</option>)}
        </optgroup>
      ))}
    </>
  );
}

function Field({ spec, values, error, onChange }: { spec: OptionSpec; values: FormValues; error: string | undefined; onChange: OnChange }) {
  const id = `opt-${spec.key.replace(/\W/g, "-")}`;
  const help = spec.hintOf?.(values) ?? spec.hint;
  const hint = error ? <span class="field-error" role="alert">{error}</span> : help ? <span class="muted">{help}</span> : null;
  switch (spec.kind) {
    case "boolean":
      return (
        <label class="check">
          <input type="checkbox" checked={values[spec.key] === true} onChange={(e) => onChange(spec.key, e.currentTarget.checked)} />
          <span>{spec.label}</span>
          {hint}
        </label>
      );
    case "number":
      return (
        <label class="field" for={id}>
          {spec.label}
          <input id={id} type="number" inputMode="numeric" min={spec.min} max={spec.max} step={spec.step ?? 1} value={String(values[spec.key] ?? spec.default)} aria-invalid={!!error} onInput={(e) => onChange(spec.key, e.currentTarget.value)} />
          {hint}
        </label>
      );
    case "select":
      return (
        <label class="field" for={id}>
          {spec.label}
          <select id={id} value={String(values[spec.key] ?? spec.default)} aria-invalid={!!error} onChange={(e) => onChange(spec.key, e.currentTarget.value)}>
            {spec.groups ? <GroupedChoices choices={spec.choices} groups={spec.groups} /> : spec.choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {spec.key === "declaredType" && <UnsupportedTypes />}
          </select>
          {hint}
          {spec.key === "declaredType" && <TypesHelpButton />}
        </label>
      );
    case "regex":
      return (
        <label class="field" for={id}>
          {spec.label}
          <input id={id} type="text" dir="ltr" spellcheck={false} value={String(values[spec.key] || spec.defaultOf?.(values) || spec.default)} aria-invalid={!!error} onInput={(e) => onChange(spec.key, e.currentTarget.value)} />
          {hint}
        </label>
      );
    case "marker": {
      const v = String(values[spec.key] ?? "auto");
      return (
        <label class="field" for={id}>
          {spec.label}
          <select id={id} value={v} aria-invalid={!!error} onChange={(e) => onChange(spec.key, e.currentTarget.value)}>
            {MARKER_CHOICES.map(([c, l]) => (
              <option key={c} value={c}>{l}</option>
            ))}
          </select>
          {(v === "tag" || v === "regex") && (
            <input
              type="text"
              dir="ltr"
              aria-label={v === "tag" ? "שם התגית" : "הביטוי הרגולרי"}
              placeholder={v === "tag" ? "small" : "\\[(\\d+)\\]"}
              value={String(values[customKey(spec.key)] ?? "")}
              aria-invalid={!!error}
              onInput={(e) => onChange(customKey(spec.key), e.currentTarget.value)}
            />
          )}
          {hint}
        </label>
      );
    }
  }
}
