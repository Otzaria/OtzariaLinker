import { describe, expect, it } from "vitest";
import { safeFileTitle, unsafeFileTitle } from "../../../src/core/links/titles";

describe("safeFileTitle", () => {
  it("keeps a safe title, and turns every unsafe one into something unsafeFileTitle accepts", () => {
    expect(safeFileTitle("ארצות החיים")).toBe("ארצות החיים");
    for (const t of ["../../x", "a/b", "a\b", "x:y?", 'a"b', "nul\u0000x", "end.", "end ", "..", "", "   ", "***"]) {
      const s = safeFileTitle(t);
      expect(unsafeFileTitle(s), `${JSON.stringify(t)} → ${JSON.stringify(s)}`).toBeNull();
    }
    expect(safeFileTitle("ספר: א?")).toBe("ספר_ א_");
    expect(safeFileTitle("", "פרויקט")).toBe("פרויקט");
  });
});
