// Sets KEY=VALUE in a dotenv file, replacing an existing line or appending.
// Usage: bun scripts/set-env.ts <file> <KEY> <VALUE>
import { readFileSync, writeFileSync } from "node:fs";

const [file, key, value] = process.argv.slice(2);
if (!file || !key || value === undefined) {
  console.error("usage: bun scripts/set-env.ts <file> <KEY> <VALUE>");
  process.exit(2);
}

const lines = readFileSync(file, "utf8").split("\n");
const index = lines.findIndex((line) => line.startsWith(`${key}=`));
if (index >= 0) lines[index] = `${key}=${value}`;
else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
writeFileSync(file, lines.join("\n"));
