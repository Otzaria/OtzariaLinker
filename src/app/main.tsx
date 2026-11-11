import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import DbWorker from "../workers/db.worker.ts?worker&inline";

/** Temporary shell (Milestone B). The real UI lands in Milestone F. */
function App() {
  const [engine, setEngine] = useState("בודק…");
  useEffect(() => {
    const w = new DbWorker();
    w.onmessage = (e: MessageEvent) => {
      const r = e.data as { ok: boolean; result?: { sqlite: string }; error?: string };
      setEngine(r.ok ? `SQLite ${r.result?.sqlite}` : `שגיאה: ${r.error}`);
      (globalThis as Record<string, unknown>).__diagnostics = r;
      w.terminate();
    };
    w.postMessage({ id: 1, op: "ping" });
  }, []);
  return (
    <main style="font-family: system-ui, sans-serif; padding: 24px">
      <h1>מנהל הקישורים של אוצריא 2.0</h1>
      <p>גרסת פיתוח {__APP_VERSION__} · {__APP_COMMIT__}</p>
      <p>מנוע מסד נתונים: <output id="engine">{engine}</output></p>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
