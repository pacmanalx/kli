import { SOURCE_TYPES, type SourceConfig } from "../types.ts";
import { FilesSourceReader } from "./files.ts";
import type { Source } from "./source.ts";

export type { Excerpt, Source } from "./source.ts";

/** A data source from its config: one file per type in this folder. */
export function openSource(name: string, config: SourceConfig): Source {
  switch (config.type) {
    case "files":
      return new FilesSourceReader(name, config);
  }
}

/** What is wrong with the config's data sources. */
export function sourceProblems(sources: Record<string, SourceConfig> | undefined): string[] {
  if (sources === undefined) return [];
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return ['"sources" is an object: { "name": { "type": "files", "paths": [...] } }'];
  const problems: string[] = [];
  for (const [name, s] of Object.entries(sources)) {
    const where = `source "${name}"`;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) problems.push(`${where}: use letters, digits, dot, dash or underscore`);
    if (!s || !SOURCE_TYPES.includes(s.type)) {
      problems.push(`${where}: type is ${SOURCE_TYPES.join(", ")}`);
      continue;
    }
    if (!Array.isArray(s.paths) || !s.paths.length || s.paths.some((p) => typeof p !== "string" || !/^[~/]/.test(p)))
      problems.push(`${where}: paths is a list of files, folders or globs, each from / or ~ ("~/docs/**/*.md")`);
  }
  return problems;
}
