import { useEffect, useState } from "preact/hooks";
import { useStore } from "./context";
import { ExportDialog } from "./dialogs/export-dialog";
import { fromDataTransfer } from "./files";
import { Home } from "./screens/home";
import { AppBar } from "./shell/app-bar";
import { Notices } from "./shell/notices";
import { Workspace } from "./workspace/workspace";

/** The whole program: app bar, the current screen, notices, and a window-wide drop target. */
export function App() {
  const store = useStore();
  const [exporting, setExporting] = useState(false);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]");
      if (typing || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (e.preventDefault(), store.undo());
      else if (k === "y" || (k === "z" && e.shiftKey)) (e.preventDefault(), store.redo());
      else if (k === "s" && store.screen.value === "workspace") (e.preventDefault(), setExporting(true));
    };
    // warn before closing with links that were not exported
    const onUnload = (e: BeforeUnloadEvent) => {
      if (store.dirty.value) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    addEventListener("beforeunload", onUnload);
    return () => (removeEventListener("keydown", onKey), removeEventListener("beforeunload", onUnload));
  }, [store]);

  // files dropped anywhere (the home screen's strip handles its own drops)
  const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  return (
    <div
      style="display:contents"
      onDragOver={(e) => isFiles(e) && (e.preventDefault(), setDropping(true))}
      onDragLeave={(e) => !e.relatedTarget && setDropping(false)}
      onDrop={async (e) => {
        setDropping(false);
        if (!isFiles(e) || !e.dataTransfer) return;
        e.preventDefault();
        await store.openFiles(await fromDataTransfer(e.dataTransfer));
      }}
    >
      <AppBar onExport={() => setExporting(true)} />
      {store.screen.value === "home" ? <Home /> : <Workspace />}
      <Notices />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {dropping && store.screen.value === "workspace" && <div class="drop-veil">שחררו כדי לפתוח</div>}
    </div>
  );
}
