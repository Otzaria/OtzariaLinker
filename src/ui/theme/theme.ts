export type ThemeSetting = "system" | "light" | "dark";

/**
 * Applies the theme setting as an explicit data-theme on <html>. For "system" it follows
 * prefers-color-scheme live. Returns a disposer that stops following.
 */
export function applyTheme(setting: ThemeSetting, root: HTMLElement = document.documentElement): () => void {
  if (setting !== "system") {
    root.dataset.theme = setting;
    return () => {};
  }
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const sync = () => {
    root.dataset.theme = mq.matches ? "dark" : "light";
  };
  sync();
  mq.addEventListener("change", sync);
  return () => mq.removeEventListener("change", sync);
}
