import type { LocationPort } from "../state/router";

/*
 * The router's address bar on window.location: only the fragment changes, which works for a page
 * opened from file:// in every browser (the History API's pushState to another path does not).
 * Assigning location.hash adds a history entry; location.replace("#…") does not.
 */
export function hashLocation(): LocationPort {
  return {
    read: () => (location.hash && location.hash !== "#" ? location.hash : "#/"),
    push: (hash) => void (location.hash = hash),
    replace: (hash) => location.replace(hash),
    back: () => history.back(),
    listen(onChange) {
      addEventListener("hashchange", onChange);
      return () => removeEventListener("hashchange", onChange);
    },
  };
}
