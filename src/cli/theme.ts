/**
 * Chart colors for the terminal, from the dataviz reference palette (light and dark steps, validated against the
 * reference surfaces and against pure black/white). The terminal background decides which set is used.
 */
export type Theme = "dark" | "light";
type Rgb = readonly [number, number, number];

export interface Tokens {
  /** Categorical slot 1: the color of every single-series chart. */
  series: Rgb;
  secondary: Rgb;
  muted: Rgb;
  baseline: Rgb;
  good: Rgb;
  warning: Rgb;
  critical: Rgb;
}

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const TOKENS: Record<Theme, Tokens> = {
  dark: {
    series: hex("#3987e5"),
    secondary: hex("#c3c2b7"),
    muted: hex("#898781"),
    baseline: hex("#383835"),
    good: hex("#0ca30c"),
    warning: hex("#fab219"),
    critical: hex("#d03b3b"),
  },
  light: {
    series: hex("#2a78d6"),
    secondary: hex("#52514e"),
    muted: hex("#898781"),
    baseline: hex("#c3c2b7"),
    good: hex("#0ca30c"),
    warning: hex("#fab219"),
    critical: hex("#d03b3b"),
  },
};

export const paint = ([r, g, b]: Rgb, text: string, on: boolean): string => (on ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m` : text);

/**
 * Which palette fits the terminal: $KLI_THEME, then $COLORFGBG, then asking the terminal for its background
 * (OSC 11). The question is followed by a device-attributes query that every terminal answers, so we know when to
 * stop waiting and no late reply leaks into the shell. Defaults to dark.
 */
export async function detectTheme(): Promise<Theme> {
  const forced = process.env.KLI_THEME;
  if (forced === "light" || forced === "dark") return forced;
  const fgbg = process.env.COLORFGBG?.split(";").at(-1);
  if (fgbg !== undefined && /^\d+$/.test(fgbg)) return [7, 15].includes(Number(fgbg)) ? "light" : "dark";
  const rgb = await askBackground();
  if (!rgb) return "dark";
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "light" : "dark";
}

/** Keys typed while Kli asked the terminal for its colors: they belong to the session, not to the answer. */
let typedAhead = "";
export function takeTypedAhead(): string {
  const keys = typedAhead;
  typedAhead = "";
  return keys;
}

function askBackground(): Promise<[number, number, number] | undefined> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let reply = "";
    const wasRaw = stdin.isRaw;
    const finish = (value?: [number, number, number]) => {
      clearTimeout(timer);
      // what is left once the terminal's answers are taken out was typed by the person
      typedAhead += reply.replace(/\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[\?[\d;]*c/g, "");
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      reply += chunk.toString();
      if (!/\x1b\[\?[\d;]*c/.test(reply)) return; // wait for the device-attributes answer
      const m = /\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
      finish(m ? (m.slice(1).map((h) => parseInt(h, 16) / (16 ** h.length - 1)) as [number, number, number]) : undefined);
    };
    const timer = setTimeout(() => finish(), 400);
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stdout.write("\x1b]11;?\x1b\\\x1b[c");
  });
}
