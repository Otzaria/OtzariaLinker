/*
 * Example only (not published, not packed by this repository): a headless Otzaria plugin over the OtzariaLinker core.
 *
 * main.js = dist-plugin/otzaria-linker-core.js followed by this file, in ONE classic script (no `import`: on Linux and Android a
 * headless plugin is loaded as a plain script from file://). docs/PLUGIN_READINESS.md §5 has the commands.
 *
 * What it does: the user presses the toolbar button in a commentary "X על Y"; the core reads the commentary and its base through
 * the SDK (read-only), runs the headings and dibur-hamatchil engines, approves what is certain, and writes the `_links.json` files
 * into the plugin's private folder (fs.writeFile). It writes nothing into the library: library books are read-only.
 */
/* global Otzaria, OtzariaLinkerCore */
Otzaria.on("reader.toolbar_item_clicked", async (event) => {
  if (event.itemId !== "link-to-base") return;
  const say = (method, message) => Otzaria.call(method, { message });
  const commentary = event.currentBookId;
  const at = commentary.lastIndexOf(" על ");
  if (at < 0) return say("ui.showError", `"${event.currentBook}" אינו "פירוש על ספר": שמו צריך להיות בצורה "X על Y".`);
  const base = commentary.slice(at + 4);
  try {
    const core = OtzariaLinkerCore.forOtzaria({ books: [commentary, base] });
    const key = OtzariaLinkerCore.otzariaBookKey;
    const links = [];
    for (const engine of ["headings", "dibur-hamatchil"]) {
      const run = await core.runPair(engine, key(commentary), key(base));
      links.push(...core.approve(run, { minConfidence: "certain", already: links }));
    }
    const plan = await core.exportFiles(links, { purpose: "private" });
    const names = await core.save(plan);
    await say("ui.showSuccess", `נשמרו ${plan.written.length} קישורים ב־${names.length} קבצים בתיקיית התוסף (${names.join(", ")}). ${plan.heldBack.length ? `${plan.heldBack.length} קישורים לא נשמרו בגלל בעיות.` : ""}`);
  } catch (err) {
    await say("ui.showError", `הקישור נכשל: ${err && err.message ? err.message : err}`);
  }
});
