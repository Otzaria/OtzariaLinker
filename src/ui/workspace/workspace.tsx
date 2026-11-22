import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { chooseLayout, resetLayout, type Layout, type PanelId } from "../../state/preferences";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { rovingKeys, rovingTabIndex, useFocusOnMount } from "../keyboard";
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
  // "source above target" puts both readers in the source's column: it stays while either is shown
  const stacked = layout.preset === "stack";
  const visible = layout.order.filter((p) => !layout.hidden.includes(p) || (stacked && p === "source" && !layout.hidden.includes("target")));
  const grid = useRef<HTMLDivElement>(null);
  // the side panel (builder, links, suggestions) is unusable below ~200px; the readers and the sources list keep 160
  const columns = visible.map((p) => `minmax(${p === "side" ? 200 : 160}px, ${layout.sizes[p]}fr)`).join(" 8px ");
  // arriving from the home screen or the guided flow, focus starts at the workspace, not at the top of the page
  useFocusOnMount(grid);

  const onPanelDrop = (target: PanelId, e: DragEvent) => {
    const from = e.dataTransfer?.getData(PANEL_DRAG) as PanelId | undefined;
    if (!from || from === target) return;
    e.preventDefault();
    const order = [...layout.order];
    const a = order.indexOf(from);
    const b = order.indexOf(target);
    if (a < 0 || b < 0) return;
    [order[a], order[b]] = [order[b]!, order[a]!];
    chooseLayout(store.prefs, { ...layout, order });
  };

  const cells: ComponentChildren[] = [];
  visible.forEach((p, i) => {
    if (i > 0) cells.push(<Splitter key={`s${i}`} left={visible[i - 1]!} right={p} grid={grid} />);
    cells.push(
      <PanelSlot key={p} id={p} onDrop={onPanelDrop}>
        {p === "source" && stacked ? <StackedReaders hidden={layout.hidden} /> : <PanelContent id={p} />}
      </PanelSlot>,
    );
  });

  return (
    <main class="workspace focus-target" ref={grid} tabIndex={-1} aria-label="סביבת העבודה" style={{ gridTemplateColumns: columns }}>
      {cells}
      {!visible.length && <AllHidden />}
    </main>
  );
}

function PanelContent({ id }: { id: PanelId }) {
  if (id === "source") return <Reader side="source" />;
  if (id === "target") return <Reader side="target" />;
  if (id === "sources") return <Panel id="sources" title="קבצים, מסדים וספרים" icon="oz_bookshelf" class="sources-panel"><SourcesBody /></Panel>;
  return <SidePanel />;
}

/** The preset "source above target": the two readers in one column, each hidden on its own. */
function StackedReaders({ hidden }: { hidden: readonly PanelId[] }) {
  const source = !hidden.includes("source");
  const target = !hidden.includes("target");
  return (
    <div class="stack-col">
      {source && <Reader side="source" />}
      {source && target && <div style="height:8px" />}
      {target && <Reader side="target" />}
    </div>
  );
}

/** Every panel hidden: say so, and bring them back from here (not only from the layout menu). */
function AllHidden() {
  const store = useStore();
  return (
    <div class="empty ws-all-hidden">
      <Icon name="fl_eye_off" size={40} />
      <span>כל הפאנלים מוסתרים.</span>
      <button class="btn filled" onClick={() => resetLayout(store.prefs, innerWidth)}>
        <Icon name="fl_layout_column_four" size={18} />
        הצגת כל הפאנלים
      </button>
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
  const tabButton = (id: typeof current, icon: Parameters<typeof Icon>[0]["name"], label: ComponentChildren) => (
    <button role="tab" id={`side-tab-${id}`} aria-selected={current === id} aria-controls="side-tabpanel" tabIndex={rovingTabIndex(current === id)} onClick={() => (store.sideTab.value = id)}>
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
  return (
    <section class="panel side-panel" aria-label="בונה וקישורים">
      <div class="tabs">
        <span class="grip" style="align-self:center;cursor:grab" draggable title="גררו כדי להזיז את הפאנל">
          <Icon name="fl_re_order_dots_vertical" size={16} />
        </span>
        {/* only tabs inside the tab list (the hide button is not a tab); arrows move between them */}
        <div role="tablist" aria-label="החלונית" onKeyDown={rovingKeys}>
          {tabButton("builder", "oz_link_add", "בונה")}
          {tabButton("links", "oz_links", <>קישורים <span class="count">{linkCount.toLocaleString("he")}</span></>)}
          {tabButton("suggestions", "oz_link_search", <>הצעות {store.suggestions.run.value && <span class="count">{store.suggestions.counts.value.pending.toLocaleString("he")}</span>}</>)}
          {tabButton("qa", "oz_link_check", <>בדיקה {store.quality.report.value && store.quality.report.value.bySeverity.error > 0 && <span class="count">{store.quality.report.value.bySeverity.error.toLocaleString("he")}</span>}</>)}
          {sourcesHidden && tabButton("books", "oz_bookshelf", "ספרים")}
        </div>
        <span class="grow" />
        <HideButton id="side" label="החלונית" />
      </div>
      <div class="panel-body" role="tabpanel" id="side-tabpanel" aria-labelledby={`side-tab-${current}`}>
        {current === "builder" ? <Builder /> : current === "links" ? <LinksPanel /> : current === "suggestions" ? <SuggestionsPanel /> : current === "qa" ? <QaPanel /> : <SourcesBody />}
      </div>
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
      chooseLayout(store.prefs, { ...start, sizes });
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
    chooseLayout(store.prefs, { ...l, sizes: { ...l.sizes, [left]: a, [right]: b } });
  };
  return <div class="splitter" role="separator" aria-orientation="vertical" tabIndex={0} aria-label="שינוי רוחב הפאנלים" onPointerDown={onDown} onKeyDown={onKey} />;
}
