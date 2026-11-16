import { ICONS, type IconName } from "./icon-data";

/** An icon from the app's own set. Decorative unless `label` is given. */
export function Icon({ name, size = 20, label, class: cls }: { name: IconName; size?: number; label?: string; class?: string }) {
  const [viewBox, body] = ICONS[name];
  return (
    <svg
      class={`icon${cls ? ` ${cls}` : ""}`}
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" })}
      // the shapes are build-time constants from the icon sets, never user data
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

export type { IconName };
