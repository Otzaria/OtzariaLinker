import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { RpcClient, type Port } from "../workers/rpc";
import type { SourcesApi } from "../workers/sources-api";
import SourcesWorker from "../workers/sources.worker.ts?worker&inline";

/** Temporary shell (Milestone B). The real UI lands in Milestone F. */
function App() {
  const [engine, setEngine] = useState("בודק…");
  useEffect(() => {
    const w = new SourcesWorker();
    new RpcClient<SourcesApi>(w as unknown as Port).call("ping", []).then(
      (r) => setEngine(`SQLite ${r.sqlite} · ${r.zstd}`),
      (e: Error) => setEngine(`שגיאה: ${e.message}`),
    );
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
