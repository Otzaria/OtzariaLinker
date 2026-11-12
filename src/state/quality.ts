import { batch, signal, type ReadonlySignal } from "@preact/signals";
import type { Link } from "../core/links/model";
import type { ValidationContext } from "../core/links/validate";
import { qaCsv, runQa, type QaReport } from "../linking/qa";
import type { LinkState } from "./history";
import type { Saver } from "./services";

/*
 * The quality check (the "בדיקה" tab): every link of the project against the export's rules
 * (linking/qa.ts, on validateExport), with the lines at both ends loaded first, and the report as CSV.
 * Checks only — it never changes a link. It uses the store's validation() and loadLinkLines(), the
 * same context the export and the builder use, so the check and the export cannot disagree.
 * Kept out of store.ts on purpose, like alt-toc.ts and ranges.ts.
 */
export interface QualityHost {
  readonly linkState: ReadonlySignal<LinkState>;
  readonly allLinks: ReadonlySignal<Link[]>;
  validation(): ValidationContext;
  loadLinkLines(label: string): Promise<boolean>;
}

export class QualityState {
  /** the last quality report; null until the user runs the check */
  readonly report = signal<QaReport | null>(null);
  /** the link revision the report was made on — a different revision means the report is stale */
  readonly revision = signal(-1);

  constructor(
    private readonly host: QualityHost,
    private readonly saver: Saver,
  ) {}

  async run(): Promise<QaReport | null> {
    if (!(await this.host.loadLinkLines("בודק את איכות הקישורים…"))) return null;
    const report = runQa(this.host.allLinks.value, this.host.validation());
    batch(() => {
      this.report.value = report;
      this.revision.value = this.host.linkState.value.revision;
    });
    return report;
  }

  saveReport(): void {
    if (this.report.value) this.saver.save(`בדיקת-קישורים-${new Date().toISOString().slice(0, 10)}.csv`, qaCsv(this.report.value), "text/csv");
  }
}
