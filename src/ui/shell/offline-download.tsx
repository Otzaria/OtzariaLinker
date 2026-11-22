import { Icon } from "../icons/icon";

/*
 * "Download the tool for offline use" (issue 26c). The hosted page (.github/workflows/pages.yml) publishes the
 * single file next to index.html under the fixed name `OtzariaLinker.html`, so the control is a plain
 * same-origin link with `download`: a navigation, not a fetch, so it is neither blocked by the CSP nor flagged
 * by the offline guard of scripts/package-release.mjs. Opened from file:// (or any non-http page) the user
 * already has the file and there is nothing to offer.
 *
 * It deliberately does NOT link to GitHub's releases/latest/download/OtzariaLinker.html: that address answers
 * 404 until a stable (non-pre-release) 4.x release carries the asset (docs/RELEASE_PROCESS.md §5).
 */
export const OFFLINE_FILE = "OtzariaLinker.html";

/** Offered only on a page served over http(s). */
export const offersOfflineDownload = (protocol: string): boolean => protocol === "http:" || protocol === "https:";

export function OfflineDownload() {
  if (!offersOfflineDownload(location.protocol)) return null;
  return (
    <a class="btn tonal offline-download" href={OFFLINE_FILE} download={OFFLINE_FILE} rel="noopener" title="קובץ אחד בגודל של כ־1MB: שומרים במחשב ופותחים בלחיצה כפולה, גם בלי אינטרנט">
      <Icon name="fl_arrow_download" size={18} />
      הורדת הכלי לעבודה בלי אינטרנט
    </a>
  );
}
