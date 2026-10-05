// Cross-platform launcher for scripts/partition.py using the project's virtualenv:
// .venv/bin/python on macOS/Linux, .venv\Scripts\python.exe on Windows.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const python =
  process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : path.join(".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`Python virtualenv not found at ${python}. Create it first (see README → Setup).`);
  process.exit(1);
}
const args = process.argv.slice(2);
const result = spawnSync(python, [path.join("scripts", "partition.py"), ...(args.length ? args : ["--strategy", "hi_res"])], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
