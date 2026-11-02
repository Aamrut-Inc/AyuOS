import { readFileSync } from "node:fs";
import { join } from "node:path";

// Prompt templates (section 15) live as files next to this module so they
// can be tuned without touching code. {{name}} is replaced; a block
// {{#if name}}...{{/if}} is kept only when `name` is truthy.

const cache = new Map<string, string>();

export function template(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(join(import.meta.dir, `${name}.md`), "utf8");
    cache.set(name, text);
  }
  return text;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function render(name: string, vars: Record<string, unknown>): string {
  let text = template(name);
  text = text.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key: string, body: string) => (vars[key] ? body : ""));
  // The preamble is a template of its own.
  if (text.includes("{{preamble}}")) text = text.replace("{{preamble}}", render("preamble", vars));
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => stringify(vars[key]));
}

// Content from records, notes, PDFs or web pages goes into prompts wrapped
// as data (6.4). Closing tags inside the content are neutralised.
export function dataBlock(source: string, content: unknown, attrs: Record<string, string> = {}): string {
  const body = stringify(content).replace(/<\/?data\b/gi, (m) => m.replace("<", "&lt;"));
  const extra = Object.entries(attrs).map(([k, v]) => ` ${k}="${v.replace(/"/g, "'")}"`).join("");
  return `<data source="${source}"${extra}>${body}</data>`;
}
