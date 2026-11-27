import { describe, expect, it } from "vitest";
import { OTZARIA_DB_DIR, OTZARIA_DB_FILE, otzariaDbCopyNotice, otzariaDbCopyText } from "../../../src/ui/workspace/otzaria-db-path";

/*
 * #16: the copy button put the whole path, seforim.db included, on the clipboard. Pasted into the file
 * dialog's "file name" field and confirmed with Enter, a file path opens the file in its own program
 * instead of selecting it. A folder path navigates the dialog to the folder, where the user picks the
 * file — Windows hides the extension, so the file shows as "seforim".
 */
describe("Otzaria database location hint", () => {
  it("copies the folder only, never the file", () => {
    const text = otzariaDbCopyText();
    expect(text).toBe(OTZARIA_DB_DIR);
    expect(text).not.toMatch(/\.db$/i);
    expect(text).not.toMatch(/seforim/i);
    expect(text).toBe("C:\\ProgramData\\otzaria\\books");
  });

  it("names the file to pick, with and without the extension Windows hides", () => {
    expect(OTZARIA_DB_FILE).toBe("seforim.db");
    const notice = otzariaDbCopyNotice();
    expect(notice).toContain("seforim");
    expect(notice).toContain("Enter");
    expect(notice).not.toContain(OTZARIA_DB_DIR); // the notice does not repeat the path it just copied
  });
});

describe("an Otzaria installed for one user (#16, V7 §3.15)", () => {
  it("is named too: the library is under %APPDATA%/otzaria/books (app_paths.dart getDefaultLibraryPath), and the file dialog expands %APPDATA%", async () => {
    const m = await import("../../../src/ui/workspace/otzaria-db-path");
    expect(m.OTZARIA_DB_DIR_USER).toBe(String.raw`%APPDATA%\otzaria\books`);
    expect(m.otzariaDbCopyText("user")).toBe(String.raw`%APPDATA%\otzaria\books`);
    expect(m.otzariaDbCopyText()).toBe(m.OTZARIA_DB_DIR);
    // the hint says where to see the real place: Otzaria's settings, library location
    expect(m.OTZARIA_DB_WHERE).toContain("הגדרות");
  });
});
