import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import type { Layout, PanelId } from "../../state/preferences";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { Builder } from "./builder";
import { LinksPanel } from "./links-panel";
import { Reader } from "./reader";
import { HideButton } from "./hide-button";
import { SourcesBody } from "./sources-panel";
import { QaPanel } from "./qa-panel";
import { SuggestionsPanel } from "./suggestions-panel";

/*
 * The workspace grid (ADR 0005 §2): panels in the order of the layout state, with draggable
 * borders between them. Dragging a panel's header onto another panel swaps their places. The
 * "stack" preset puts the target reader under the source reader in one column.
 */
const PANEL_DRAG = "application/x-otzaria-panel";

export function Workspace() {
  const store = useStore();
  const layout = store.prefs.layout.value;
  const visible = layout.order.filter((p) => !layout.hidden.includes(p));
  const grid = useRef<HTMLDivElement>(null);
  const columns = visible.map((p) => `minmax(160px, ${layout.sizes[p]}fr)`).join(" 8px ");

  const onPanelDrop = (target: PanelId, e: DragEvent) => {
    const from = e.dataTransfer?.getData(PANEL_DRAG) as PanelId | undefined;
    if (!from || from === target) return;
    e.preventDefault();
    const order = [...layout.order];
    const a = order.indexOf(from);
    const b = order.indexOf(target);
    if (a < 0 || b < 0) return;
    [order[a], order[b]] = [order[b]!, order[a]!];
    store.prefs.layout.value = { ...layout, order };
  };

  const cells: ComponentChildren[] = [];
  visible.forEach((p, i) => {
    if (i > 0) cells.push(<Splitter key={`s${i}`} left={visible[i - 1]!} right={p} grid={grid} />);
    cells.push(
      <PanelSlot key={p} id={p} onDrop={onPanelDrop}>
        {p === "source" && layout.preset === "stack" ? <StackedReaders /> : <PanelContent id={p} />}
      </PanelSlot>,
    );
  });

  return (
    <main class="workspace" ref={grid} style={{ gridTemplateColumns: columns }}>
      {cells}
    </main>
  );
}

function PanelContent({ id }: { id: PanelId }) {
  if (id === "source") return <Reader side="source" />;
  if (id === "target") return <Reader side="target" />;
  if (id === "sources") return <Panel id="sources" title="מקורות וספרים" icon="oz_bookshelf" class="sources-panel"><SourcesBody /></Panel>;
  return <SidePanel />;
}

function StackedReaders() {
  return (
    <div class="stack-col">
      <Reader side="source" />
      <div style="height:8px" />
      <Reader side="target" />
    </div>
  );
}

/** A grid cell that accepts another panel's header being dropped on it. */
function PanelSlot({ id, onDrop, children }: { id: PanelId; onDrop: (target: PanelId, e: DragEvent) => void; children: ComponentChildren }) {
  return (
    <div
      class="stack-col"
      onDragStart={(e) => {
        const head = (e.target as HTMLElement).closest?.(".panel-head, .tabs .grip");
        if (head && e.dataTransfer) {
          e.dataTransfer.setData(PANEL_DRAG, id);
          e.dataTransfer.effectAllowed = "move";
        }
      }}
      onDragOver={(e) => e.dataTransfer?.types.includes(PANEL_DRAG) && (e.preventDefault(), e.currentTarget.firstElementChild?.classList.add("drag-over"))}
      onDragLeave={(e) => e.currentTarget.firstElementChild?.classList.remove("drag-over")}
      onDrop={(e) => (e.currentTarget.firstElementChild?.classList.remove("drag-over"), onDrop(id, e))}
    >
      {children}
    </div>
  );
}

export function Panel({ id, title, icon, children, actions, class: cls }: { id: PanelId; title: string; icon: Parameters<typeof Icon>[0]["name"]; children: ComponentChildren; actions?: ComponentChildren; class?: string }) {
  return (
    <section class={`panel${cls ? ` ${cls}` : ""}`} aria-label={title}>
      <div class="panel-head" draggable>
        <span class="grip" title="גררו כדי להזיז את הפאנל">
          <Icon name="fl_re_order_dots_vertical" size={16} />
        </span>
        <h2 class="grow">
          <Icon name={icon} size={18} />
          {title}
        </h2>
        {actions}
        <HideButton id={id} label={title} />
      </div>
      <div class="panel-body">{children}</div>
    </section>
  );
}

function SidePanel() {
  const store = useStore();
  const tab = store.sideTab.value;
  const layout = store.prefs.layout.value;
  const sourcesHidden = layout.hidden.includes("sources") || !layout.order.includes("sources");
  const linkCount = store.allLinks.value.length;
  const current = tab === "books" && !sourcesHidden ? "builder" : tab;
  return (
    <section class="panel side-panel" aria-label="בונה וקישורים">
      <div class="tabs" role="tablist">
        <span class="grip" style="align-self:center;cursor:grab" draggable title="גררו כדי להזיז את הפאנל">
          <Icon name="fl_re_order_dots_vertical" size={16} />
        </span>
        <button role="tab" aria-selected={current === "builder"} onClick={() => (store.sideTab.value = "builder")}>
          <Icon name="oz_link_add" size={16} />
          בונה
        </button>
        <button role="tab" aria-selected={current === "links"} onClick={() => (store.sideTab.value = "links")}>
          <Icon name="oz_links" size={16} />
          קישורים <span class="count">{linkCount.toLocaleString("he")}</span>
        </button>
        <button role="tab" aria-selected={current === "suggestions"} onClick={() => (store.sideTab.value = "suggestions")}>
          <Icon name="oz_link_search" size={16} />
          הצעות {store.run.value && <span class="count">{store.suggestionCounts.value.pending.toLocaleString("he")}</span>}
        </button>
        <button role="tab" aria-selected={current === "qa"} onClick={() => (store.sideTab.value = "qa")}>
          <Icon name="oz_link_check" size={16} />
          בדיקה {store.qa.value && store.qa.value.bySeverity.error > 0 && <span class="count">{store.qa.value.bySeverity.error.toLocaleString("he")}</span>}
        </button>
        <span class="grow" />
        <HideButton id="side" label="החלונית" />
        {sourcesHidden && (
          <button role="tab" aria-selected={current === "books"} onClick={() => (store.sideTab.value = "books")}>
            <Icon name="oz_bookshelf" size={16} />
            ספרים
          </button>
        )}
      </div>
      <div class="panel-body">{current === "builder" ? <Builder /> : current === "links" ? <LinksPanel /> : current === "suggestions" ? <SuggestionsPanel /> : current === "qa" ? <QaPanel /> : <SourcesBody />}</div>
    </section>
  );
}

/** The draggable border between two panels; changes their relative widths. */
function Splitter({ left, right, grid }: { left: PanelId; right: PanelId; grid: { current: HTMLDivElement | null } }) {
  const store = useStore();
  const onDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const prev = el.previousElementSibling as HTMLElement | null;
    const next = el.nextElementSibling as HTMLElement | null;
    if (!prev || !next || !grid.current) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    const start: Layout = store.prefs.layout.value;
    const x0 = e.clientX;
    const wPrev = prev.getBoundingClientRect().width;
    const wNext = next.getBoundingClientRect().width;
    const fr = start.sizes[left] + start.sizes[right];
    const rtl = getComputedStyle(grid.current).direction === "rtl";
    const move = (ev: PointerEvent) => {
      // in RTL the earlier column is on the right: moving the pointer left widens it
      const dx = (ev.clientX - x0) * (rtl ? -1 : 1);
      const a = Math.min(Math.max(wPrev + dx, 160), wPrev + wNext - 160);
      const sizes = { ...start.sizes, [left]: (fr * a) / (wPrev + wNext), [right]: (fr * (wPrev + wNext - a)) / (wPrev + wNext) };
      store.prefs.layout.value = { ...start, sizes };
    };
    const up = () => {
      el.classList.remove("active");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const l = store.prefs.layout.value;
    const step = 0.1 * (e.key === "ArrowLeft" ? 1 : -1);
    const a = Math.max(0.3, l.sizes[left] + step);
    const b = Math.max(0.3, l.sizes[right] - step);
    store.prefs.layout.value = { ...l, sizes: { ...l.sizes, [left]: a, [right]: b } };
  };
  return <div class="splitter" role="separator" aria-orientation="vertical" tabIndex={0} aria-label="שינוי רוחב הפאנלים" onPointerDown={onDown} onKeyDown={onKey} />;
}
