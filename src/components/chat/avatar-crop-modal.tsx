"use client";

import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type Crop = { x: number; y: number; size: number };
type Drag = { mode: "move" | "resize"; px: number; py: number } & Crop;

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/**
 * Square-crop a picked image before saving it as an avatar. The user can drag
 * the selection to reposition and use the corner handle to resize; a live
 * preview shows the result. Save renders the selection to a 256px JPEG.
 */
export function AvatarCropModal({
  src,
  onCancel,
  onSave,
}: {
  src: string;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, size: 0 });

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const scale = Math.min(360 / img.naturalWidth, 380 / img.naturalHeight);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    setDisp({ w, h });
    const size = Math.min(w, h) * 0.85;
    setCrop({ x: (w - size) / 2, y: (h - size) / 2, size });
  };

  const startDrag = useCallback(
    (mode: "move" | "resize", e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { mode, px: e.clientX, py: e.clientY, ...crop };
    },
    [crop],
  );
  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || !disp) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (d.mode === "move") {
        setCrop({
          size: d.size,
          x: clamp(d.x + dx, 0, disp.w - d.size),
          y: clamp(d.y + dy, 0, disp.h - d.size),
        });
      } else {
        const max = Math.min(disp.w - d.x, disp.h - d.y);
        setCrop({ x: d.x, y: d.y, size: clamp(d.size + Math.max(dx, dy), 48, max) });
      }
    },
    [disp],
  );
  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  const save = () => {
    const img = imgRef.current;
    if (!img || !disp) return;
    const scale = img.naturalWidth / disp.w; // natural px per display px
    const out = 256;
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(
      img,
      crop.x * scale,
      crop.y * scale,
      crop.size * scale,
      crop.size * scale,
      0,
      0,
      out,
      out,
    );
    onSave(canvas.toDataURL("image/jpeg", 0.85));
  };

  const previewBg =
    disp && crop.size
      ? {
          backgroundImage: `url(${src})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${(disp.w / crop.size) * 56}px ${(disp.h / crop.size) * 56}px`,
          backgroundPosition: `${(-crop.x / crop.size) * 56}px ${(-crop.y / crop.size) * 56}px`,
        }
      : undefined;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="flex w-[440px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[440px]">
        <div className="flex h-14 shrink-0 items-center border-b border-app-border px-5">
          <DialogTitle className="text-[16px] font-bold">
            Add a profile photo
          </DialogTitle>
        </div>

        <div className="flex justify-center bg-panel-2 p-4">
          <div
            className="relative select-none overflow-hidden"
            style={{ width: disp?.w, height: disp?.h, touchAction: "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={src}
              alt="To crop"
              draggable={false}
              onLoad={onImgLoad}
              style={{ width: disp?.w, height: disp?.h, display: "block" }}
            />
            {disp && (
              <div
                onPointerDown={(e) => startDrag("move", e)}
                onPointerMove={onMove}
                onPointerUp={endDrag}
                className="absolute cursor-move"
                style={{
                  left: crop.x,
                  top: crop.y,
                  width: crop.size,
                  height: crop.size,
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
                  outline: "2px dashed #fff",
                }}
              >
                <div
                  onPointerDown={(e) => startDrag("resize", e)}
                  onPointerMove={onMove}
                  onPointerUp={endDrag}
                  className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-se-resize rounded-sm border-2 border-white"
                  style={{ background: "var(--app-accent)" }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-app-border px-5 py-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            Preview
          </div>
          <div
            className="size-14 shrink-0 rounded-lg border border-app-border bg-panel-2"
            style={previewBg}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-app-border px-4 py-1.5 text-[13.5px] font-medium text-app-muted hover:bg-panel-hover"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-md px-4 py-1.5 text-[13.5px] font-semibold"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            Save
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
