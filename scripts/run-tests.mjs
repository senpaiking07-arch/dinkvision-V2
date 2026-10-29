import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const collect = async (directory, suffix) =>
  (await readdir(directory))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => resolve(directory, name));

// Windows shells do not expand the globs in package.json. Resolve the files in
// Node so npm test always runs the same complete suite on every platform.
const files = [
  ...(await collect("tests", ".test.ts")),
  ...(await collect("recorder", ".test.mjs")),
];

const child = spawn(
  process.execPath,
  [
    resolve("node_modules", "tsx", "dist", "cli.mjs"),
    "--test",
    "--test-concurrency=1",
    ...files,
  ],
  { stdio: "inherit", shell: false },
);

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner stopped by ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
