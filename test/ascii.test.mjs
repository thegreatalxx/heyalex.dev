// the pure parts of packages/ascii-glaze (the canvas parts need a browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import { RAMP, charFor, rowText, cropFor } from "../packages/ascii-glaze/index.js";

test("charFor: black is a space, white is the densest character, out-of-range values are clamped", () => {
  assert.equal(charFor(0), " ");
  assert.equal(charFor(1), RAMP.at(-1));
  assert.equal(charFor(-3), " ");
  assert.equal(charFor(9), RAMP.at(-1));
  assert.equal(charFor(0.5, "ab", 1), "b", "rounds to the nearest step");
  assert.ok(RAMP.indexOf(charFor(0.2)) > RAMP.indexOf(charFor(0.2, RAMP, 1)), "gamma below 1 lifts the shadows");
});

test("rowText: one character per pixel, by rec. 709 brightness", () => {
  const px = (r, g, b) => [r, g, b, 255];
  const data = new Uint8ClampedArray([...px(0, 0, 0), ...px(255, 255, 255), ...px(0, 255, 0), ...px(0, 0, 255)]);
  const row = rowText(data, 4, 0, RAMP, 1);
  assert.equal(row.length, 4);
  assert.equal(row[0], " ");
  assert.equal(row[1], RAMP.at(-1));
  assert.ok(RAMP.indexOf(row[2]) > RAMP.indexOf(row[3]), "green reads brighter than blue");
});

test("cropFor: cover crops the long side around the centre, contain takes the whole source", () => {
  assert.deepEqual(cropFor(400, 200, 100, 100), [100, 0, 200, 200]);
  assert.deepEqual(cropFor(200, 400, 100, 50), [0, 150, 200, 100]);
  assert.deepEqual(cropFor(400, 200, 100, 100, "contain"), [0, 0, 400, 200]);
});
