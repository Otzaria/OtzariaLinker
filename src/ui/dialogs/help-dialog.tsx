import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import guide from "../../../docs/USER_GUIDE.md?raw";
import { renderGuide } from "../help/markdown";
import { Icon } from "../icons/icon";

/*
 * Help (F1, or the question mark in the app bar): the user guide, rendered from docs/USER_GUIDE.md,
 * with a side navigation of its sections. `section` opens it at a heading id, for help buttons that
 * point at the part of the guide about the panel they sit in.
 */
export function HelpDialog({ section, onClose }: { section?: string | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => renderGuide(guide), []);
  const [current, setCurrent] = useState(section ?? rendered.toc[0]?.id ?? "");

  const go = (id: string) => {
    const el = content.current?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    // the closest level-2 section, for the navigation highlight
    const top = rendered.toc.find((t) => t.id === id) ? id : sectionOf(el);
    if (top) setCurrent(top);
  };

  useEffect(() => {
    ref.current?.showModal();
    if (section) go(section);
  }, []);

  return (
    <dialog ref={ref} class="help-dialog" onClose={onClose} aria-labelledby="help-title">
      <div class="dlg">
        <header>
          <Icon name="fl_question_circle" size={24} />
          <h2 id="help-title">עזרה — מדריך למשתמש</h2>
          <span class="grow" />
          <button class="icon-btn" onClick={() => ref.current?.close()} aria-label="סגירת העזרה" title="סגירה (Esc)">
            <Icon name="fl_dismiss" />
          </button>
        </header>
        <div class="help-layout">
          <nav class="help-nav" aria-label="פרקי המדריך">
            {rendered.toc.map((t) => (
              <a key={t.id} href={`#${t.id}`} aria-current={t.id === current ? "location" : undefined} onClick={(e) => (e.preventDefault(), go(t.id))}>
                {t.text}
              </a>
            ))}
          </nav>
          <div
            ref={content}
            class="help-content"
            tabIndex={0}
            // in-guide links scroll the guide; they must never navigate the page (file:// would lose the work)
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest?.("a[data-anchor]");
              if (!a) return;
              e.preventDefault();
              go(a.getAttribute("data-anchor")!);
            }}
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        </div>
      </div>
    </dialog>
  );
}

function sectionOf(el: Element): string | null {
  for (let n: Element | null = el; n; n = n.previousElementSibling) if (n.tagName === "H2") return n.id;
  return null;
}
