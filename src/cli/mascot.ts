/**
 * Kli's golem, in pixels. Each terminal cell holds 2×2 pixels (quadrant characters), with the light of the eyes
 * and of the inscription in the foreground and the clay in the background.
 *
 * `#` clay · `o` eye · `t` `m` `a` the letters of emet (אמת, "truth"): tav, mem and aleph, right to left as Hebrew
 * is written. In the legend, erasing the aleph leaves met (מת, "dead") and the golem stops.
 */
const STAND = [
  ".....##########.....",
  "....##tt#mm#aa##....",
  "....##oo####oo##....",
  "....############....",
  "....############....",
  ".....##########.....",
  "...##.########.##...",
  "...##.########.##...",
  "...##.###..###.##...",
  "......###..###......",
];

/** The poses of the animation, on the same 20×10 grid. */
const POSES = {
  stand: STAND,
  // walking in place: a leg up, the opposite arm forward
  "step-left": [
    ".....##########.....",
    "....##tt#mm#aa##....",
    "....##oo####oo##....",
    "....############....",
    "....############....",
    ".....############...",
    "......########.##...",
    "...##.########.##...",
    "...##.###..###......",
    "...##......###......",
  ],
  "step-right": [
    ".....##########.....",
    "....##tt#mm#aa##....",
    "....##oo####oo##....",
    "....############....",
    "....############....",
    "...############.....",
    "...##.########......",
    "...##.########.##...",
    "......###..###.##...",
    "......###......##...",
  ],
  // waving: the right arm up, the hand going out and back
  "wave-up": [
    ".....##########.....",
    "....##tt#mm#aa####..",
    "....##oo####oo####..",
    "....##############..",
    "....##############..",
    ".....##########.##..",
    "...##.########.##...",
    "...##.########.##...",
    "...##.###..###......",
    "......###..###......",
  ],
  "wave-out": [
    ".....##########...##",
    "....##tt#mm#aa##..##",
    "....##oo####oo##.##.",
    "....############.##.",
    "....##############..",
    ".....##########.##..",
    "...##.########.##...",
    "...##.########.##...",
    "...##.###..###......",
    "......###..###......",
  ],
  // shaking the head: "no"
  "shake-left": [
    "...##########.......",
    "..##tt#mm#aa##......",
    "..##oo####oo##......",
    "..############......",
    "..############......",
    "...##########.......",
    "...##.########.##...",
    "...##.########.##...",
    "...##.###..###.##...",
    "......###..###......",
  ],
  "shake-right": [
    ".......##########...",
    "......##tt#mm#aa##..",
    "......##oo####oo##..",
    "......############..",
    "......############..",
    ".......##########...",
    "...##.########.##...",
    "...##.########.##...",
    "...##.###..###.##...",
    "......###..###......",
  ],
  // collapsing: crouched, then sitting on the ground
  crouch: [
    "....................",
    ".....##########.....",
    "....##tt#mm#aa##....",
    "....##oo####oo##....",
    "....############....",
    "....############....",
    ".....##########.....",
    "...##.########.##...",
    "...##.########.##...",
    "......###..###......",
  ],
  sit: [
    "....................",
    "....................",
    ".....##########.....",
    "....##tt#mm#aa##....",
    "....##oo####oo##....",
    "....############....",
    "....############....",
    ".....##########.....",
    "..##.##########.##..",
    "..##.##########.##..",
  ],
} satisfies Record<string, string[]>;

export type Pose = keyof typeof POSES;

/** One frame of the golem. */
export interface Look {
  pose: Pose;
  /** Eyes open (lit). */
  eyes: boolean;
  /** Letters of the inscription lit, from the right (aleph, then mem, then tav); the others glow dim. */
  lit: 0 | 1 | 2 | 3;
  /** met: the aleph is erased. */
  dead?: boolean;
}

/** emet: awake · blink: eyes closed, still alive · met: stopped. */
export type GolemState = "emet" | "blink" | "met";
const STATES: Record<GolemState, Look> = {
  emet: { pose: "stand", eyes: true, lit: 3 },
  blink: { pose: "stand", eyes: false, lit: 3 },
  met: { pose: "stand", eyes: false, lit: 0, dead: true },
};

type Rgb = readonly [number, number, number];

const CLAY: Rgb = [196, 122, 74];
const LIGHT: Rgb = [255, 214, 90];
const UNLIT: Rgb = [140, 82, 48];

const QUADRANTS = " ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█"; // index = top-left·8 + top-right·4 + bottom-left·2 + bottom-right·1
const LETTERS: Record<string, number> = { a: 1, m: 2, t: 3 };

const fg = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: Rgb) => `\x1b[48;2;${r};${g};${b}m`;
const quadrant = (bits: boolean[]) => QUADRANTS[bits.reduce((n, b) => n * 2 + (b ? 1 : 0), 0)]!;

function pixelColor(p: string, look: Look): Rgb | undefined {
  if (p === ".") return undefined;
  if (p === "o") return look.eyes ? LIGHT : CLAY;
  const letter = LETTERS[p];
  if (letter === undefined) return CLAY;
  if (look.dead) return letter === 1 ? CLAY : UNLIT;
  return letter <= look.lit ? LIGHT : UNLIT;
}

/** The golem's 5 lines for one frame. Without color, open eyes become holes and the inscription does not show. */
export function drawGolem(look: Look, color = true): string[] {
  const grid = POSES[look.pose];
  const pixel = (y: number, x: number) => grid[y]?.[x] ?? ".";
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = "";
    for (let x = 0; x < 20; x += 2) {
      const px = [pixel(y, x), pixel(y, x + 1), pixel(y + 1, x), pixel(y + 1, x + 1)];
      if (!color) {
        line += quadrant(px.map((p) => p !== "." && !(look.eyes && p === "o")));
        continue;
      }
      const colors = px.map((p) => pixelColor(p, look));
      const distinct = [...new Set(colors.filter(Boolean))] as Rgb[];
      if (distinct.length === 0) line += " ";
      else if (distinct.length === 1) line += fg(distinct[0]!) + quadrant(colors.map(Boolean)) + "\x1b[0m";
      else {
        // two colors in one cell: the less frequent goes in front, the other in the background
        const count = (c: Rgb) => colors.filter((x) => x === c).length;
        const [minor, major] = distinct.sort((a, b) => count(a) - count(b)) as [Rgb, Rgb];
        line += fg(minor) + bg(major) + quadrant(colors.map((c) => c === minor)) + "\x1b[0m";
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** The golem standing, in one of its three states. */
export function golem(state: GolemState = "emet", color = true): string[] {
  return drawGolem(STATES[state], color);
}

export const GOLEM_WIDTH = 10;

/** Every pose side by side, with its name (`kli golem`). */
export function gallery(color: boolean): string[] {
  const shots: [string, Look][] = [
    ["emet", STATES.emet],
    ["blink", STATES.blink],
    ["walk", { pose: "step-left", eyes: true, lit: 3 }],
    ["walk", { pose: "step-right", eyes: true, lit: 3 }],
    ["wave", { pose: "wave-up", eyes: true, lit: 3 }],
    ["wave", { pose: "wave-out", eyes: true, lit: 3 }],
    ["writing", { pose: "stand", eyes: true, lit: 1 }],
    ["shake", { pose: "shake-left", eyes: true, lit: 3 }],
    ["shake", { pose: "shake-right", eyes: true, lit: 3 }],
    ["collapse", { pose: "crouch", eyes: false, lit: 0, dead: true }],
    ["met", { pose: "sit", eyes: false, lit: 0, dead: true }],
    ["asleep", { pose: "stand", eyes: false, lit: 0 }],
  ];
  const cell = GOLEM_WIDTH + 3;
  const pad = (s: string) => s + " ".repeat(Math.max(0, cell - Bun.stringWidth(s)));
  const out: string[] = [];
  for (let i = 0; i < shots.length; i += 6) {
    const row = shots.slice(i, i + 6);
    const drawn = row.map(([, look]) => drawGolem(look, color));
    for (let y = 0; y < 5; y++) out.push((" " + drawn.map((d) => pad(d[y] ?? "")).join("")).trimEnd());
    const names = " " + row.map(([name]) => pad(`  ${name}`)).join("");
    out.push(color ? `\x1b[2m${names.trimEnd()}\x1b[0m` : names.trimEnd(), "");
  }
  return out.slice(0, -1);
}
