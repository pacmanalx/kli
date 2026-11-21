import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Color definitions matching src/cli/mascot.ts
const CLAY = "#c47a4a";
const LIGHT = "#ffd65a";
const UNLIT = "#8c5230";

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

const POSES: Record<string, string[]> = {
  stand: STAND,
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
  "shake-left": [
    "...##########.......",
    "..##tt#mm#aa##......",
    "..##oo####oo##......",
    "..############......",
    "..############......",
    "...##########.......",
    "..##.########.##...",
    "..##.########.##...",
    "..##.###..###.##...",
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
};

const LETTERS: Record<string, number> = { a: 1, m: 2, t: 3 };

export interface Look {
  pose: keyof typeof POSES;
  eyes: boolean;
  lit: 0 | 1 | 2 | 3;
  dead?: boolean;
}

export function getPixelColor(p: string, look: Look): string | null {
  if (p === ".") return null;
  if (p === "o") return look.eyes ? LIGHT : CLAY;
  const letter = LETTERS[p];
  if (letter === undefined) return CLAY;
  if (look.dead) return letter === 1 ? CLAY : UNLIT;
  return letter <= look.lit ? LIGHT : UNLIT;
}

export function generateSvgSnippet(look: Look, pixelSize = 16, offsetX = 0, offsetY = 0): { rects: string; glow: string } {
  const grid = POSES[look.pose];
  let rects = "";
  let glow = "";

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < 20; x++) {
      const p = row[x] ?? ".";
      const color = getPixelColor(p, look);
      if (!color) continue;
      const px = offsetX + x * pixelSize;
      const py = offsetY + y * pixelSize;

      rects += `<rect x="${px}" y="${py}" width="${pixelSize}" height="${pixelSize}" fill="${color}" />\n`;

      if (color === LIGHT) {
        glow += `<rect x="${px}" y="${py}" width="${pixelSize}" height="${pixelSize}" fill="${LIGHT}" />\n`;
      }
    }
  }

  return { rects, glow };
}

export function generateFullSvg(look: Look, pixelSize = 16, padding = 1): string {
  const width = (20 + padding * 2) * pixelSize;
  const height = (10 + padding * 2) * pixelSize;
  const { rects, glow } = generateSvgSnippet(look, pixelSize, padding * pixelSize, padding * pixelSize);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges">
  <defs>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${pixelSize * 0.7}" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <g class="golem-body">
    ${rects}
  </g>
  ${glow ? `<g filter="url(#glow)" opacity="0.65">\n${glow}</g>` : ""}
</svg>`;
}

export function generateGallerySvg(): string {
  const shots: [string, Look][] = [
    ["emet", { pose: "stand", eyes: true, lit: 3 }],
    ["blink", { pose: "stand", eyes: false, lit: 3 }],
    ["walk (1)", { pose: "step-left", eyes: true, lit: 3 }],
    ["walk (2)", { pose: "step-right", eyes: true, lit: 3 }],
    ["wave (1)", { pose: "wave-up", eyes: true, lit: 3 }],
    ["wave (2)", { pose: "wave-out", eyes: true, lit: 3 }],
    ["writing", { pose: "stand", eyes: true, lit: 1 }],
    ["shake (1)", { pose: "shake-left", eyes: true, lit: 3 }],
    ["shake (2)", { pose: "shake-right", eyes: true, lit: 3 }],
    ["collapse", { pose: "crouch", eyes: false, lit: 0, dead: true }],
    ["met", { pose: "sit", eyes: false, lit: 0, dead: true }],
    ["asleep", { pose: "stand", eyes: false, lit: 0 }],
  ];

  const pixelSize = 10;
  const cols = 6;
  const rows = 2;
  const cellWidth = 26 * pixelSize;
  const cellHeight = 16 * pixelSize;
  const totalWidth = cols * cellWidth;
  const totalHeight = rows * cellHeight;

  let content = "";
  let glowContent = "";
  let labels = "";

  shots.forEach(([name, look], index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const originX = col * cellWidth + 3 * pixelSize;
    const originY = row * cellHeight + 1.5 * pixelSize;

    const { rects, glow } = generateSvgSnippet(look, pixelSize, originX, originY);
    content += rects;
    glowContent += glow;

    const labelX = originX + 10 * pixelSize;
    const labelY = originY + 12.5 * pixelSize;
    labels += `<text x="${labelX}" y="${labelY}" fill="#94a3b8" font-family="'JetBrains Mono', 'Fira Code', monospace" font-size="12" text-anchor="middle">${name}</text>\n`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="#0a0d14" rx="12" />
  <defs>
    <filter id="gal-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${pixelSize * 0.6}" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <g class="gallery-bodies">
    ${content}
  </g>
  <g filter="url(#gal-glow)" opacity="0.6">
    ${glowContent}
  </g>
  <g class="gallery-labels">
    ${labels}
  </g>
</svg>`;
}

async function main() {
  const outDir = join(process.cwd(), "landing", "assets");
  await mkdir(outDir, { recursive: true });

  const looks: Record<string, Look> = {
    emet: { pose: "stand", eyes: true, lit: 3 },
    blink: { pose: "stand", eyes: false, lit: 3 },
    walk1: { pose: "step-left", eyes: true, lit: 3 },
    walk2: { pose: "step-right", eyes: true, lit: 3 },
    wave1: { pose: "wave-up", eyes: true, lit: 3 },
    wave2: { pose: "wave-out", eyes: true, lit: 3 },
    writing: { pose: "stand", eyes: true, lit: 1 },
    shake1: { pose: "shake-left", eyes: true, lit: 3 },
    shake2: { pose: "shake-right", eyes: true, lit: 3 },
    collapse: { pose: "crouch", eyes: false, lit: 0, dead: true },
    met: { pose: "sit", eyes: false, lit: 0, dead: true },
    asleep: { pose: "stand", eyes: false, lit: 0 },
  };

  // Generate individual SVGs
  for (const [name, look] of Object.entries(looks)) {
    const svg = generateFullSvg(look, 16, 1);
    const svgPath = join(outDir, `golem-${name}.svg`);
    await Bun.write(svgPath, svg);
  }

  // Generate Gallery SVG
  const gallerySvg = generateGallerySvg();
  const galleryPath = join(outDir, "golem-gallery.svg");
  await Bun.write(galleryPath, gallerySvg);

  // Generate high-resolution PNGs via headless Chrome
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  console.log("Generating high-resolution PNGs with Chrome headless...");

  for (const name of Object.keys(looks)) {
    const svgPath = join(outDir, `golem-${name}.svg`);
    const pngPath = join(outDir, `golem-${name}.png`);
    try {
      await exec(chromePath, [
        "--headless",
        "--disable-gpu",
        `--screenshot=${pngPath}`,
        "--window-size=352,192",
        "--default-background-color=00000000",
        `file://${svgPath}`
      ]);
    } catch (err) {
      console.warn(`Could not render PNG for ${name}:`, err);
    }
  }

  // Gallery PNG
  try {
    await exec(chromePath, [
      "--headless",
      "--disable-gpu",
      `--screenshot=${join(outDir, "golem-gallery.png")}`,
      "--window-size=1560,320",
      "--default-background-color=00000000",
      `file://${galleryPath}`
    ]);
  } catch (err) {
    console.warn("Could not render PNG for gallery:", err);
  }

  console.log("Mascot assets (SVG and PNG) generated successfully!");
}

main().catch(console.error);
