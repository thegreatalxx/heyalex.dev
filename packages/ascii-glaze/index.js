// ascii-glaze: draw any image, video or canvas as coloured ASCII on a <canvas>.
// It's the renderer behind heyalex.dev's skyline. The source is sampled down to one pixel per character,
// each pixel's brightness picks a character from a ramp, and then the white text is "glazed" with the
// source's own colours (composited source-in), over a faint pixel underlay.

export const RAMP = " .`'-:;~=+*ixcoaeOQ#%&@";

// brightness (0..1) to a character. gamma below 1 lifts the shadows so dark scenes keep some texture.
export function charFor(lum, ramp = RAMP, gamma = 0.8) {
  const k = Math.round(Math.pow(Math.min(1, Math.max(0, lum)), gamma) * (ramp.length - 1));
  return ramp[k];
}

// one row of characters from rgba pixel data (rec. 709 luma)
export function rowText(data, width, row, ramp = RAMP, gamma = 0.8) {
  let s = "";
  for (let x = 0; x < width; x++) {
    const i = (row * width + x) * 4;
    s += charFor((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255, ramp, gamma);
  }
  return s;
}

// the part of the source to sample so it fills a w x h box ("cover") or fits inside it whole ("contain")
export function cropFor(sw, sh, w, h, fit = "cover") {
  if (fit !== "cover" || !sw || !sh) return [0, 0, sw, sh];
  const k = Math.max(w / sw, h / sh), cw = w / k, ch = h / k;
  return [(sw - cw) / 2, (sh - ch) / 2, cw, ch];
}

const sizeOf = src => [src.naturalWidth || src.videoWidth || src.width || 0, src.naturalHeight || src.videoHeight || src.height || 0];

// renders `source` into `target` once and returns the grid size. call it again to redraw
// (on resize, or every frame for video). the target's css size decides the resolution.
export function asciify(target, source, opts = {}) {
  const {
    fontSize = 8, lineHeight = fontSize + 1, ramp = RAMP, gamma = 0.8, fit = "cover",
    font = '"JetBrains Mono", ui-monospace, Menlo, monospace', underlay = 0.25, background = null,
    dpr = Math.min(2, globalThis.devicePixelRatio || 1),
  } = opts;
  const box = target.getBoundingClientRect(), W = Math.max(1, box.width), H = Math.max(1, box.height);
  target.width = Math.round(W * dpr);
  target.height = Math.round(H * dpr);
  const text = document.createElement("canvas"), small = document.createElement("canvas");
  text.width = target.width;
  text.height = target.height;
  const tx = text.getContext("2d");
  tx.font = `${fontSize}px ${font}`;
  const cw = tx.measureText("M").width || fontSize * 0.6, cols = Math.ceil(W / cw), rows = Math.ceil(H / lineHeight);
  small.width = cols;
  small.height = rows;
  const sx = small.getContext("2d", { willReadFrequently: true });
  const [sw, sh] = sizeOf(source);
  if (sw && sh) sx.drawImage(source, ...cropFor(sw, sh, W, H, fit), 0, 0, cols, rows);
  const data = sx.getImageData(0, 0, cols, rows).data;

  // white characters first, then the source's colours composited onto them
  tx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tx.font = `${fontSize}px ${font}`;
  tx.textBaseline = "top";
  tx.fillStyle = "#fff";
  for (let y = 0; y < rows; y++) tx.fillText(rowText(data, cols, y, ramp, gamma), 0, y * lineHeight);
  tx.setTransform(1, 0, 0, 1, 0, 0);
  tx.globalCompositeOperation = "source-in";
  tx.imageSmoothingEnabled = false;
  tx.drawImage(small, 0, 0, text.width, text.height);

  const out = target.getContext("2d");
  out.clearRect(0, 0, target.width, target.height);
  if (background) {
    out.fillStyle = background;
    out.fillRect(0, 0, target.width, target.height);
  }
  if (underlay > 0) {
    out.globalAlpha = underlay;
    out.imageSmoothingEnabled = false;
    out.drawImage(small, 0, 0, target.width, target.height);
    out.globalAlpha = 1;
  }
  out.drawImage(text, 0, 0);
  return { cols, rows };
}

// keeps redrawing a source that changes (a video, or a canvas you draw a scene into), at most `fps`
// times a second. returns stop(). with prefers-reduced-motion it draws once and stops.
export function animate(target, source, opts = {}) {
  const { fps = 15, ...rest } = opts;
  let on = true, last = -Infinity;
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const frame = t => {
    if (!on) return;
    if (t - last >= 1000 / fps) {
      last = t;
      if (typeof opts.draw === "function") opts.draw(t / 1000);
      asciify(target, source, rest);
      if (still) return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => { on = false; };
}
