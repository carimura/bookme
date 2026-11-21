import assert from "node:assert/strict";
import { test } from "node:test";
import { slotStarts, subtract } from "../src/slots.ts";

const MIN = 60_000;
const at = (hhmm: string) => Date.parse(`2026-12-01T${hhmm}:00Z`);
const times = (xs: number[]) => xs.map((t) => new Date(t).toISOString().slice(11, 16));
const rules = { duration: 30 * MIN, step: 30 * MIN, buffer: 0, earliest: 0, latest: Infinity };

test("subtract removes busy time from open windows", () => {
  assert.deepEqual(subtract([[0, 10], [20, 30]], [[2, 4], [8, 22], [25, 26]]), [[0, 2], [4, 8], [22, 25], [26, 30]]);
  assert.deepEqual(subtract([[0, 10]], [[0, 10]]), []);
  assert.deepEqual(subtract([[0, 10]], []), [[0, 10]]);
  assert.deepEqual(subtract([[5, 10]], [[0, 6], [9, 20]]), [[6, 9]]);
});

test("slots fill the free time on the half hour", () => {
  const open: [number, number][] = [[at("15:00"), at("19:00")]];
  const busy: [number, number][] = [[at("16:15"), at("17:10")]];
  assert.deepEqual(times(slotStarts(open, busy, rules)), ["15:00", "15:30", "17:30", "18:00", "18:30"]);
});

test("a buffer keeps slots away from busy time but not from window edges", () => {
  const open: [number, number][] = [[at("15:00"), at("18:00")]];
  const busy: [number, number][] = [[at("16:00"), at("16:30")]];
  assert.deepEqual(times(slotStarts(open, busy, { ...rules, buffer: 15 * MIN })), ["15:00", "17:00", "17:30"]);
});

test("notice and horizon limits, and longer meetings on a half-hour step", () => {
  const open: [number, number][] = [[at("15:00"), at("18:00")]];
  assert.deepEqual(times(slotStarts(open, [], { ...rules, earliest: at("15:10"), latest: at("17:00") })), ["15:30", "16:00", "16:30"]);
  assert.deepEqual(times(slotStarts(open, [], { ...rules, duration: 60 * MIN })), ["15:00", "15:30", "16:00", "16:30", "17:00"]);
});
