import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadPyodide } from "pyodide";

// The sandbox process: CPython compiled to WebAssembly (Pyodide), started by
// agent/sandbox/index.ts under a macOS sandbox profile that denies network
// access and file writes. Requests arrive as JSON lines on stdin; each runs
// model-written Python against `data` and answers with `result`.
//
// Inside Python, three more layers: the code is parsed and rejected if it
// imports anything outside an allow-list or touches dunder attributes, it
// runs with a reduced set of builtins (no open/eval/exec/compile/getattr),
// and imports go through a guarded __import__.

const GUARD = String.raw`
import ast, builtins, io, json, sys, math
import numpy as np
import pandas as pd
import ayu_stats

ALLOWED_MODULES = {"numpy", "pandas", "scipy", "math", "statistics", "json", "datetime", "collections", "itertools",
                   "functools", "ayu_stats", "re", "typing", "dataclasses", "decimal", "fractions", "operator", "bisect", "heapq"}
BLOCKED_NAMES = {"open", "eval", "exec", "compile", "__import__", "globals", "locals", "vars", "getattr", "setattr",
                 "delattr", "input", "breakpoint", "help", "memoryview", "exit", "quit", "__builtins__", "__loader__", "__spec__"}

class Rejected(Exception):
    pass

def check_code(code):
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for name in names:
                if name.split(".")[0] not in ALLOWED_MODULES:
                    raise Rejected(f"import of '{name}' is not allowed")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise Rejected(f"access to '{node.attr}' is not allowed")
        elif isinstance(node, ast.Name) and (node.id in BLOCKED_NAMES or node.id.startswith("__")):
            raise Rejected(f"use of '{node.id}' is not allowed")
    return tree

_real_import = builtins.__import__
def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name.split(".")[0] not in ALLOWED_MODULES:
        raise ImportError(f"import of '{name}' is not allowed in the sandbox")
    return _real_import(name, globals, locals, fromlist, level)

SAFE_BUILTINS = {k: getattr(builtins, k) for k in dir(builtins) if not k.startswith("_") and k not in BLOCKED_NAMES}
SAFE_BUILTINS["__import__"] = guarded_import
SAFE_BUILTINS["__build_class__"] = builtins.__build_class__
SAFE_BUILTINS["__name__"] = "analysis"

def run_analysis(code, data_json):
    tree = check_code(code)
    raw = json.loads(data_json)
    data = {name: pd.DataFrame(rows) for name, rows in raw.items()}
    env = {"__builtins__": SAFE_BUILTINS, "data": data, "pd": pd, "np": np, "s": ayu_stats, "ayu_stats": ayu_stats, "math": math}
    exec(compile(tree, "<analysis>", "exec"), env)
    if "result" not in env:
        raise Rejected("the code did not set 'result'")
    return json.dumps(ayu_stats._clean(env["result"]), allow_nan=False, default=str)
`;

const ayuStatsDir = join(import.meta.dir, "ayu_stats");
const py = await loadPyodide();
await py.loadPackage(["numpy", "pandas", "scipy"], { messageCallback: () => {} });
py.FS.mkdirTree("/home/pyodide/ayu_stats");
for (const file of readdirSync(ayuStatsDir).filter((f) => f.endsWith(".py"))) {
  py.FS.writeFile(`/home/pyodide/ayu_stats/${file}`, readFileSync(join(ayuStatsDir, file), "utf8"));
}
py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
py.runPython(GUARD);
// Nothing in the JS world is reachable from analysis code (no `js` import),
// and the OS profile blocks the network and file writes; drop fetch anyway.
(globalThis as any).fetch = undefined;

let stdout = "";
py.setStdout({ batched: (line: string) => { stdout += `${line}\n`; } });
py.setStderr({ batched: (line: string) => { stdout += `${line}\n`; } });

const runAnalysis = py.globals.get("run_analysis");
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
send({ ready: true });

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const req = JSON.parse(line) as { id: number; code: string; data: unknown };
  stdout = "";
  try {
    const result = runAnalysis(req.code, JSON.stringify(req.data ?? {}));
    send({ id: req.id, ok: true, result: JSON.parse(result), stdout: stdout.slice(0, 8000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep the Python traceback's last lines; that's what the explainer needs.
    send({ id: req.id, ok: false, error: message.split("\n").slice(-12).join("\n"), stdout: stdout.slice(0, 8000) });
  }
}
