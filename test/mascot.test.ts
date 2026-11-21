import { expect, test } from "bun:test";
import { drawGolem, gallery, golem } from "../src/cli/mascot.ts";

const LIGHT = "255;214;90";

test("without color, the lit golem has holes for eyes; stopped, the eyes close", () => {
  expect(golem("emet", false)).toEqual(["  ▟████▙", "  █▄██▄█", "  ▜████▛", " ▐▌████▐▌", " ▝▘█▌▐█▝▘"]);
  expect(golem("met", false)[1]).toBe("  ██████");
});

test("the poses keep the golem in its 10 columns", () => {
  expect(drawGolem({ pose: "step-left", eyes: true, lit: 3 }, false)).toEqual(["  ▟████▙", "  █▄██▄█", "  ▜█████▖", " ▗▖████▐▌", " ▐▌▀▘▐█"]);
  expect(drawGolem({ pose: "wave-out", eyes: true, lit: 3 }, false)[1]).toBe("  █▄██▄█▐▌");
  expect(drawGolem({ pose: "sit", eyes: false, lit: 0, dead: true }, false)).toEqual(["", "  ▟████▙", "  ██████", "  ▜████▛", " █▐████▌█"]);
  for (const line of gallery(false)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
});

test("the inscription lights from the right; met erases the aleph", () => {
  const lights = (lit: 0 | 1 | 2 | 3, dead = false) => drawGolem({ pose: "stand", eyes: false, lit, dead }, true)[0]!.split(LIGHT).length - 1;
  expect(lights(0)).toBe(0);
  // mem sits across two cells (x 9-10): 1, then 3, then 4 lit cells
  expect([1, 2, 3].map((n) => lights(n as 1 | 2 | 3))).toEqual([1, 3, 4]);
  expect(lights(3, true)).toBe(0);
  // with one letter lit, the light is in the 7th cell (x 12-13): the aleph, the rightmost letter
  const row = drawGolem({ pose: "stand", eyes: false, lit: 1 }, true)[0]!;
  const before = row.slice(0, row.search(/\x1b\[[34]8;2;255;214;90m/)).replace(/\x1b\[[0-9;]*m/g, "");
  expect(Bun.stringWidth(before)).toBe(6);
});
