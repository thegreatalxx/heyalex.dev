# ascii-glaze

Draw any image, video or canvas as coloured ASCII on a `<canvas>`. It's the renderer behind the skyline on [heyalex.dev](https://heyalex.dev).

```js
import { asciify } from "ascii-glaze";

const img = new Image();
img.src = "/photo.jpg";
img.onload = () => asciify(document.querySelector("canvas"), img);
```

No dependencies, about 120 lines, works in any modern browser.

## How it works

1. The source is drawn into a tiny canvas with one pixel per character cell.
2. Each pixel's brightness picks a character from a ramp: `` .`'-:;~=+*ixcoaeOQ#%&@``.
3. The characters are drawn in white, then the tiny canvas is drawn over them with `source-in`, so every character takes the colour of the part of the image it stands for. That's the "glaze".
4. A faint, blocky copy of the image sits underneath so the picture still reads at a distance.

## API

### `asciify(target, source, options?)`

Renders once and returns `{ cols, rows }`. Call it again to redraw, on resize or every frame for video. The target's CSS size sets the resolution.

| option | default | |
|---|---|---|
| `fontSize` | `8` | character size in CSS pixels |
| `lineHeight` | `fontSize + 1` | row height |
| `ramp` | `` .`'-:;~=+*ixcoaeOQ#%&@`` | darkest to brightest |
| `gamma` | `0.8` | below 1 lifts the shadows |
| `fit` | `"cover"` | `"cover"` crops to fill, `"contain"` stretches the whole source |
| `underlay` | `0.25` | opacity of the blocky colour layer underneath, `0` for none |
| `background` | `null` | fill colour behind everything |
| `font` | `"JetBrains Mono", ui-monospace, Menlo, monospace` | any monospace font |

### `animate(target, source, options?)`

Keeps redrawing a source that changes, such as a `<video>` or a canvas you draw a scene into, at most `fps` times a second (default 15). Pass `draw(seconds)` to update your scene before each frame. Returns `stop()`. With `prefers-reduced-motion` it draws once and stops.

```js
import { animate } from "ascii-glaze";

const scene = document.createElement("canvas");
scene.width = 320; scene.height = 180;
const g = scene.getContext("2d");
const stop = animate(document.querySelector("canvas"), scene, {
  draw: t => {
    g.fillStyle = "#08091a"; g.fillRect(0, 0, 320, 180);
    g.fillStyle = "#ffd060"; g.beginPath(); g.arc(160 + Math.sin(t) * 80, 90, 30, 0, 7); g.fill();
  },
});
```

### `charFor(brightness)`, `rowText(data, width, row)`, `cropFor(sw, sh, w, h, fit)`

The pure helpers underneath, in case you want to render ASCII somewhere else (a terminal, the DOM, a test).

## Demo

Open `demo.html` from this folder in a browser and drop in an image or video.

## License

MIT
