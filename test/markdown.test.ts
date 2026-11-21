import { describe, expect, test } from "bun:test";
import { markdown } from "../src/cli/markdown.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const rowsOf = (text: string, w = 80, color = false) => markdown(text, w, color).rows;

// the answer that showed the problem on 10/11/2026: a table whose rows the old wrap cut across lines
const LOGIN = [
  "## Caminhos para publicar o site",
  "",
  "| Caminho | Precisa de servidor? | Depende de |",
  "|---|---|---|",
  '| **1. "Publicar pelo GitHub Pages"** com o workflow do `pages-deploy` | não, o GitHub serve os arquivos da própria branch | o dono do `pages-deploy` confirmar que ele está em produção e apontar o domínio próprio para o GitHub |',
  "| **2. Agora:** copiar a pasta `dist` pelo `publica-site.sh`, com o nome da máquina como destino e uma chave própria de SSH | não | nada, já funciona hoje |",
  "| **3. O site chamar a `RenderPage`** | sim | o time liberar a função; refazer o cache no servidor |",
].join("\n");

describe("markdown on the terminal", () => {
  test("bold, italics and code lose their marks and keep their text, styled when there is color", () => {
    expect(rowsOf("a **bold** word, an *italic* one and `code`")).toEqual(["a bold word, an italic one and code"]);
    const [row] = rowsOf("a **bold** word and `code`", 80, true);
    expect(row).toContain("\x1b[1mbold\x1b[0m");
    expect(row).toContain("\x1b[36mcode\x1b[0m");
  });

  test("marks that are not emphasis stay as typed: snake_case, 2 * 3, a lone star", () => {
    expect(rowsOf("use file_name_here and 2 * 3 * 4, or a* alone")).toEqual(["use file_name_here and 2 * 3 * 4, or a* alone"]);
    expect(rowsOf("an `unclosed backtick and **unclosed bold")).toEqual(["an `unclosed backtick and **unclosed bold"]);
    expect(rowsOf("escaped \\*stars\\* stay")).toEqual(["escaped *stars* stay"]);
  });

  test("a heading shows its text without the hashes, bold", () => {
    expect(rowsOf("## Caminhos para liberar")).toEqual(["Caminhos para liberar"]);
    expect(rowsOf("# Título", 80, true)[0]).toBe("\x1b[1;4mTítulo\x1b[0m");
  });

  test("a list item keeps its mark and wraps under its own text", () => {
    const rows = rowsOf("- um item longo o bastante para quebrar a linha em duas partes\n  - dentro\n1. primeiro", 30);
    expect(rows[0]).toBe("- um item longo o bastante");
    expect(rows[1]).toBe("  para quebrar a linha em duas");
    expect(rows[2]).toBe("  partes");
    expect(rows).toContain("  - dentro");
    expect(rows.at(-1)).toBe("1. primeiro");
    expect(rowsOf("* star item")).toEqual(["- star item"]);
  });

  test("a code block keeps its lines and indentation, without the fences, and nothing inside is read as markdown", () => {
    expect(rowsOf("```ts\nconst a = **b**;\n  if (x) y();\n```\ndepois")).toEqual(["  const a = **b**;", "    if (x) y();", "depois"]);
  });

  test("a quote and a rule are drawn, not typed", () => {
    expect(rowsOf("> citado")).toEqual(["▎ citado"]);
    expect(rowsOf("---", 10)).toEqual(["─".repeat(10)]);
  });

  test("a link keeps its address beside its text; an address alone shows once", () => {
    expect(rowsOf("veja [a doc](https://x.dev/a) e <https://y.dev>")).toEqual(["veja a doc (https://x.dev/a) e https://y.dev"]);
  });

  test("a table is drawn with borders, its cells wrapped inside columns that fit the width", () => {
    for (const w of [118, 80]) {
      const rows = rowsOf(LOGIN, w);
      expect(rows[0]).toBe("Caminhos para publicar o site");
      expect(rows[2]!.startsWith("┌")).toBe(true);
      expect(rows.at(-1)!.startsWith("└")).toBe(true);
      for (const r of rows) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(w);
      // every table row has its borders in the same columns
      const box = rows.slice(2);
      expect(new Set(box.map((r) => Bun.stringWidth(r))).size).toBe(1);
      const text = rows.join("\n");
      for (const raw of ["**", "|---", "`"]) expect(text).not.toContain(raw);
      expect(text).toContain("pages-deploy");
      expect(text).toContain("RenderPage");
    }
  });

  test("a table that fits keeps one line per row, aligned as the rule says", () => {
    expect(rowsOf("| a | número |\n|:-:|--:|\n| x | 10 |\n| yy | 2 |")).toEqual([
      "┌────┬────────┐",
      "│ a  │ número │",
      "├────┼────────┤",
      "│ x  │     10 │",
      "│ yy │      2 │",
      "└────┴────────┘",
    ]);
  });

  test("a pipe inside code or escaped belongs to its cell", () => {
    const rows = rowsOf("| cmd | o quê |\n|---|---|\n| `a | b` | pipe \\| aqui |");
    expect(rows[3]).toBe("│ a | b │ pipe | aqui │");
  });

  test("a table too wide for its columns becomes one record per row, each cell under its column's name", () => {
    const rows = rowsOf(LOGIN, 40);
    expect(rows.join("\n")).not.toContain("┌");
    expect(rows).toContain("Caminho: 1. \"Publicar pelo GitHub Pages\"");
    expect(rows.some((r) => r.startsWith("Precisa de servidor?: não"))).toBe(true);
    for (const r of rows) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(40);
  });

  test("every row fits the width, with color too", () => {
    const text = `${LOGIN}\n\n- **item** com \`código\` e um texto comprido que precisa quebrar\n\n\`\`\`\n${"x".repeat(120)}\n\`\`\``;
    for (const w of [20, 33, 61, 100]) for (const r of markdown(text, w, true).rows) expect(Bun.stringWidth(plain(r))).toBeLessThanOrEqual(w);
  });

  test("while the answer comes, the settled rows never change, whatever comes after them", () => {
    const full = `${LOGIN}\n\nDepois da tabela, um parágrafo com **negrito**.\n\n- item\n\n\`\`\`\ncódigo\n\`\`\`\n| só | um |\n|---|---|\n| a | b |\nfim`;
    const end = markdown(full, 70, true).rows;
    for (let k = 1; k <= full.length; k++) {
      const now = markdown(full.slice(0, k), 70, true);
      expect(now.rows.slice(0, now.settled)).toEqual(end.slice(0, now.settled));
    }
  });

  test("the line being written and a table that may still grow are not settled", () => {
    expect(markdown("pronto\nescrevendo", 80, false).settled).toBe(1);
    expect(markdown("pronto\n", 80, false).settled).toBe(1);
    expect(markdown("antes\n| a | b |\n|---|---|\n| 1 | 2 |\n", 80, false).settled).toBe(1);
    expect(markdown("antes\n| a | b |\n", 80, false).settled).toBe(1);
    expect(markdown("antes\n| a | b |\n|---|---|\n| 1 | 2 |\ndepois\n", 80, false).settled).toBe(7);
  });
});
