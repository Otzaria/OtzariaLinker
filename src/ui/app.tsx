import { useEffect, useState } from "preact/hooks";
import { useStore } from "./context";
import { AltTocDialog } from "./dialogs/alt-toc-dialog";
import { DbMappingDialog } from "./dialogs/db-mapping-dialog";
import { ExportDialog } from "./dialogs/export-dialog";
import { HelpDialog } from "./dialogs/help-dialog";
import { RecordsDialog } from "./dialogs/records-dialog";
import { RelinkDialog } from "./dialogs/relink-dialog";
import { fromDataTransfer } from "./files";
import { GuidedScreen } from "./screens/guided";
import { Home, StartTaskDialog } from "./screens/home";
import { AppBar } from "./shell/app-bar";
import { Notices } from "./shell/notices";
import { Workspace } from "./workspace/workspace";

/** The whole program: app bar, the current screen, notices, and a window-wide drop target. */
export function App() {
  const store = useStore();
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (store.dialog.value !== "help") store.openHelp();
        return;
      }
      const typing = (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]");
      // shortcuts belong to the workspace; on the home screen Ctrl+S would save an empty project
      if (typing || !(e.ctrlKey || e.metaKey) || store.screen.value !== "workspace") return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (e.preventDefault(), store.undo());
      else if (k === "y" || (k === "z" && e.shiftKey)) (e.preventDefault(), store.redo());
      else if (k === "s") (e.preventDefault(), store.saveProject());
      // the history list (v3 had Ctrl+H): opened through its own button, so focus and closing behave the same
      else if (k === "h") (e.preventDefault(), document.querySelector<HTMLButtonElement>(".history-menu .menu > button.icon-btn")?.click());
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
        const files = await fromDataTransfer(e.dataTransfer);
        // in the guided flow a drop anywhere on its first step chooses the books; on a later step it adds bases
        if (store.screen.value === "guided") await (store.guided.step.value === "files" ? store.guided.addBooks(files) : store.guided.addBases(files));
        else await store.openFiles(files);
      }}
    >
      <AppBar onExport={() => (store.dialog.value = "export")} />
      {store.screen.value === "home" ? <Home /> : store.screen.value === "guided" ? <GuidedScreen /> : <Workspace />}
      <Notices />
      {/* dialogs are routes (state/router.ts): closing one goes back in history; Back closes it */}
      {store.dialog.value === "export" && <ExportDialog onClose={() => store.closeDialog("export")} />}
      {store.dialog.value === "relink" && <RelinkDialog onClose={() => store.closeDialog("relink")} />}
      {store.dialog.value === "help" && <HelpDialog section={store.helpSection.value} onSection={(id) => (store.helpSection.value = id)} onClose={() => store.closeDialog("help")} />}
      {store.dialog.value === "alt-toc" && <AltTocDialog onClose={() => store.closeDialog("alt-toc")} />}
      {store.dialog.value === "start" && <StartTaskDialog onClose={() => store.closeDialog("start")} />}
      <DbMappingDialog />
      <RecordsDialog />
      {dropping && store.screen.value === "workspace" && <div class="drop-veil">שחררו כדי לפתוח</div>}
    </div>
  );
}
