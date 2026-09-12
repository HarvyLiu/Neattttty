import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

export interface CtxItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  children?: CtxItem[];
}

const PANEL_W = 232;
const ROW_H = 34;
const PAD = 7;

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const height = items.length * ROW_H + PAD * 2;
  const left = Math.max(8, Math.min(x, window.innerWidth - PANEL_W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  const subOpensLeft = left + PANEL_W + PANEL_W > window.innerWidth;

  const run = (it: CtxItem) => {
    if (it.disabled || it.children) return;
    onClose();
    it.action?.();
  };

  return (
    <div
      className="ctx-overlay"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="ctx-menu"
        style={{ left, top, width: PANEL_W }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => (
          <div key={i} onMouseEnter={() => setOpenSub(it.children ? i : null)}>
            <button
              className={`ctx-item${it.danger ? " danger" : ""}`}
              disabled={it.disabled}
              onClick={() => run(it)}
            >
              <span>{it.label}</span>
              {it.children && <ChevronRight size={14} />}
            </button>
            {it.children && openSub === i && (
              <div
                className="ctx-menu ctx-sub"
                style={{
                  width: PANEL_W,
                  ...(subOpensLeft ? { right: "100%" } : { left: "100%" }),
                  top: Math.min(PAD + i * ROW_H, Math.max(0, window.innerHeight - top - it.children.length * ROW_H - PAD * 2 - 8)),
                }}
              >
                {it.children.map((sub, j) => (
                  <button
                    key={j}
                    className="ctx-item"
                    disabled={sub.disabled}
                    onClick={() => run(sub)}
                  >
                    <span>{sub.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
