import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadTestEnvironment } from "./r2-local-env.mjs";

const [command = "dev", ...args] = process.argv.slice(2);
const commands = {
  dev: [resolve("node_modules/next/dist/bin/next"), "dev", "--hostname", "0.0.0.0"],
  build: [resolve("node_modules/next/dist/bin/next"), "build"],
  jobs: [resolve("scripts/browser-jobs.mjs")],
  migrate: [resolve("scripts/migrate.mjs")],
  account: [resolve("scripts/provision-account.mjs"), ...args],
};
try {
  if (!commands[command]) throw new Error("Use dev, build, jobs, migrate, or account.");
  const env = await loadTestEnvironment(command);
  const child = spawn(process.execPath, commands[command], { env, stdio: "inherit", shell: false });
  child.on("error", () => { console.error("Could not start local test command."); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
