import type { PipPosition } from "../../../multifocal/compositeStream";

export const resolvePipMarginPx = (
  mainWidth: number,
  mainHeight: number,
  rawMargin: unknown,
  defaultPx = 10,
): number => {
  const v = Number(rawMargin);
  if (rawMargin === undefined || rawMargin === null) return defaultPx;
  if (!Number.isFinite(v) || v < 0) return defaultPx;

  // Legacy: values > 1 are treated as pixels.
  if (v > 1) return Math.floor(v);

  // New: treat as fraction (0..1) of output size.
  const base = Math.min(Math.max(1, Math.floor(mainWidth)), Math.max(1, Math.floor(mainHeight)));
  return Math.max(0, Math.floor(base * v));
};

export const calculatePipOverlayPosition = (params: {
  position: PipPosition;
  mainWidth: number;
  mainHeight: number;
  pipWidth: number;
  pipHeight: number;
  margin: number;
}): { left: number; top: number } => {
  const pipW = Math.max(1, Math.floor(params.pipWidth));
  const pipH = Math.max(1, Math.floor(params.pipHeight));
  const margin = Math.max(0, Math.floor(params.margin));
  const mainW = Math.max(1, Math.floor(params.mainWidth));
  const mainH = Math.max(1, Math.floor(params.mainHeight));

  const clamp = (x: number, min: number, max: number) => Math.min(Math.max(x, min), max);
  const maxX = Math.max(0, mainW - pipW);
  const maxY = Math.max(0, mainH - pipH);

  let left = margin;
  let top = margin;

  switch (params.position) {
    case "top-left":
      left = margin;
      top = margin;
      break;
    case "top-right":
      left = mainW - pipW - margin;
      top = margin;
      break;
    case "bottom-left":
      left = margin;
      top = mainH - pipH - margin;
      break;
    case "bottom-right":
      left = mainW - pipW - margin;
      top = mainH - pipH - margin;
      break;
    case "center":
      left = Math.floor((mainW - pipW) / 2);
      top = Math.floor((mainH - pipH) / 2);
      break;
    case "top-center":
      left = Math.floor((mainW - pipW) / 2);
      top = margin;
      break;
    case "bottom-center":
      left = Math.floor((mainW - pipW) / 2);
      top = mainH - pipH - margin;
      break;
    case "left-center":
      left = margin;
      top = Math.floor((mainH - pipH) / 2);
      break;
    case "right-center":
      left = mainW - pipW - margin;
      top = Math.floor((mainH - pipH) / 2);
      break;
  }

  return {
    left: clamp(left, 0, maxX),
    top: clamp(top, 0, maxY),
  };
};
