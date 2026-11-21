import { expect, test } from "bun:test";
import { Animator, TIMING } from "../src/cli/animation.ts";

const T0 = 1_000_000;
const pose = (a: Animator, t: number) => a.look(T0 + t).look.pose;

test("says hello when Kli opens, then stands; a key cuts the hello short", () => {
  const a = new Animator(T0);
  expect([0, 200, 400, 1000].map((t) => pose(a, t))).toEqual(["wave-up", "wave-out", "wave-up", "wave-out"]);
  expect(pose(a, TIMING.hello)).toBe("stand");
  const b = new Animator(T0);
  b.input(T0 + 100);
  expect(pose(b, 200)).toBe("stand");
});

test("blinks every 3 s, for 150 ms", () => {
  const a = new Animator(T0);
  expect(a.look(T0 + 2849).look.eyes).toBe(true);
  expect(a.look(T0 + 2850).look.eyes).toBe(false);
  expect(a.look(T0 + 3000).look.eyes).toBe(true);
  expect(a.look(T0 + 5850).look.eyes).toBe(false);
  // after the hello, the next change is the blink
  expect(a.look(T0 + 1300).next).toBe(1550);
});

test("waves every 30 s while nobody types; each key restarts the count", () => {
  const a = new Animator(T0);
  expect(pose(a, 29_999)).toBe("stand");
  expect(a.look(T0 + 29_000).next).toBeLessThanOrEqual(1000);
  expect(pose(a, 30_000)).toBe("wave-up");
  expect(pose(a, 30_200)).toBe("wave-out");
  expect(pose(a, 30_000 + TIMING.wave)).toBe("stand");
  expect(pose(a, 60_000)).toBe("wave-up");
  a.input(T0 + 59_000);
  expect(pose(a, 60_000)).toBe("stand");
  expect(pose(a, 89_000)).toBe("wave-up");
});

test("walks while waiting, runs while the answer arrives, writing emet letter by letter", () => {
  const a = new Animator(T0);
  a.sync("waiting", T0 + 5000);
  expect([5000, 5200, 5400, 5600, 5800].map((t) => pose(a, t))).toEqual(["step-left", "stand", "step-right", "stand", "step-left"]);
  expect(a.look(T0 + 5050).next).toBe(150);
  a.sync("streaming", T0 + 6000);
  expect([6000, 6120, 6240].map((t) => pose(a, t))).toEqual(["step-left", "stand", "step-right"]);
  expect([6000, 6240, 6480, 6720, 6960].map((t) => a.look(T0 + t).look.lit)).toEqual([1, 2, 3, 3, 1]);
});

test("shakes its head on a fallback, then walks on", () => {
  const a = new Animator(T0);
  a.sync("waiting", T0 + 5000);
  a.fallback(T0 + 5100);
  expect([5100, 5250, 5400, 5550].map((t) => pose(a, t))).toEqual(["shake-left", "stand", "shake-right", "stand"]);
  // the walk keeps its own clock (from 5000): 5700 is its 4th frame, 5800 a new step
  expect([5700, 5800].map((t) => pose(a, t))).toEqual(["stand", "step-left"]);
});

test("collapses on an error and stays sitting, without the aleph", () => {
  const a = new Animator(T0);
  a.sync("error", T0 + 5000);
  expect(a.look(T0 + 5000).look).toEqual({ pose: "crouch", eyes: false, lit: 0, dead: true });
  const sitting = a.look(T0 + 5000 + TIMING.crouch);
  expect(sitting.look.pose).toBe("sit");
  expect(sitting.next).toBe(Infinity);
  a.sync("waiting", T0 + 9000);
  expect(pose(a, 9000)).toBe("step-left");
});

test("falls asleep after 5 min without input and wakes up on a key; still when animation is off", () => {
  const a = new Animator(T0);
  const asleep = a.look(T0 + TIMING.sleepAfter);
  expect(asleep.look).toEqual({ pose: "stand", eyes: false, lit: 0 });
  expect(asleep.next).toBe(Infinity);
  a.input(T0 + TIMING.sleepAfter + 10);
  expect(a.look(T0 + TIMING.sleepAfter + 20).look.lit).toBe(3);

  const still = new Animator(T0, false);
  expect(still.look(T0).look).toEqual({ pose: "stand", eyes: true, lit: 3 });
  still.sync("waiting", T0 + 100);
  expect(still.look(T0 + 300)).toEqual({ look: { pose: "stand", eyes: true, lit: 3 }, next: Infinity });
});
