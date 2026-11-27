import { Icon } from "../icons/icon";

/*
 * "Download the tool for offline use" (issue 26c). The hosted page (.github/workflows/pages.yml) publishes the
 * single file next to index.html under the fixed name `OtzariaLinker.html`, so the control is a plain
 * same-origin link with `download`: a navigation, not a fetch, so it is neither blocked by the CSP nor flagged
 * by the offline guard of scripts/package-release.mjs. Opened from file:// (or any non-http page) the user
 * already has the file and there is nothing to offer.
 *
 * It deliberately does NOT link to GitHub's releases/latest/download/OtzariaLinker.html: that address answers
 * 404 until a stable (non-pre-release) 4.x release carries the asset (docs/RELEASE_PROCESS.md §5), and once it
 * works it is the latest STABLE release, which can be older than the page that is open. The same-origin file is
 * deployed together with the page, so it is always the version the user sees; the button says which version
 * that is, and whether it is a development build of main (V7 spec §4.21, docs/release/V7_RELEASE_READINESS.md).
 */
export const OFFLINE_FILE = "OtzariaLinker.html";

/** Offered only on a page served over http(s). */
export const offersOfflineDownload = (protocol: string): boolean => protocol === "http:" || protocol === "https:";

const SIZE = "קובץ אחד בגודל של כ־2MB: שומרים במחשב ופותחים בלחיצה כפולה, גם בלי אינטרנט.";

/** The version line of the button and its tooltip. A semver pre-release ("4.0.0-alpha.0") is a development build. */
export function offlineDownloadText(version: string | undefined, commit: string | undefined): { badge: string; title: string } {
  if (!version) return { badge: "", title: `אותה גרסה שפתוחה כאן. ${SIZE}` };
  const at = commit ? ` (${commit})` : "";
  if (version.includes("-")) {
    return {
      badge: `גרסת פיתוח ${version}`,
      title: `גרסת פיתוח ${version}${at} מהענף הראשי, אותה גרסה שפתוחה כאן. זו אינה גרסה יציבה: גרסאות יציבות נמצאות בדף ה־Releases של המאגר. ${SIZE}`,
    };
  }
  return { badge: `גרסה ${version}`, title: `גרסה ${version}${at}, אותה גרסה שפתוחה כאן. ${SIZE}` };
}

export function OfflineDownload() {
  if (!offersOfflineDownload(location.protocol)) return null;
  const { badge, title } = offlineDownloadText(
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined,
    typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : undefined,
  );
  return (
    <a class="btn tonal offline-download" href={OFFLINE_FILE} download={OFFLINE_FILE} rel="noopener" title={title}>
      <Icon name="fl_arrow_download" size={18} />
      הורדת הכלי לעבודה בלי אינטרנט
      {badge && <span class="muted" dir="auto">({badge})</span>}
    </a>
  );
}
