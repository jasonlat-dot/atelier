import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] || "all";
const windows = process.platform === "win32";
const children = new Set();
let stopping = false;

async function freePort(port) {
  await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Port ${port} is unavailable. Stop the existing service with Ctrl+C first.`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolvePort));
  });
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const closed = new Promise((done) => child.once("close", done));
  if (windows) {
    // Stop Cargo/Vite descendants as well, without touching another service on a port.
    await new Promise((done) => {
      const killer = spawn(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("error", done);
      killer.once("close", done);
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  let timer;
  await Promise.race([
    closed,
    new Promise((done) => {
      timer = setTimeout(() => {
        if (!windows) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH")
              console.error("[Atelier] Could not stop a service.");
          }
        }
        done();
      }, 3000);
    }),
  ]);
  clearTimeout(timer);
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  console.log("\n[Atelier] Stopping development services...");
  await Promise.allSettled([...children].map(stopChild));
  process.exit(code);
}

function start(name, command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
    detached: !windows,
  });
  children.add(child);
  child.once("error", () => {
    console.error(
      `[Atelier] Could not start ${name}. Check its runtime/dependencies.`,
    );
    void stop(1);
  });
  child.once("close", (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[Atelier] ${name} exited (code ${code ?? "signal"}).`);
      void stop(code || 1);
    }
  });
}

async function main() {
  if (!["all", "api", "web"].includes(mode))
    throw new Error("Use npm run dev, dev:api, or dev:web.");
  const api = join(root, "services", "api");
  const web = join(root, "apps", "web");
  const vite = join(web, "node_modules", "vite", "bin", "vite.js");
  let backendEnv;
  if (mode !== "web") {
    const file = join(api, ".env");
    if (!existsSync(file))
      throw new Error("Configure services/api/.env before starting the API.");
    let settings;
    try {
      settings = parseEnv(readFileSync(file, "utf8"));
    } catch {
      throw new Error(
        "Invalid services/api/.env format; expected KEY=VALUE configuration.",
      );
    }
    backendEnv = { ...process.env, ...settings };
    await freePort(8080);
  }
  if (mode !== "api") {
    if (!existsSync(vite))
      throw new Error(
        "Install web dependencies first: npm --prefix apps/web ci",
      );
    await freePort(5173);
  }
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  console.log(
    "[Atelier] Starting real development services. Ctrl+C stops them together.",
  );
  if (mode !== "web")
    start(
      "API",
      "cargo",
      ["run", "--locked", "-p", "atelier-app"],
      api,
      backendEnv,
    );
  if (mode !== "api") {
    // Server credentials are only loaded into the API process, never Vite.
    start(
      "Web",
      process.execPath,
      [
        vite,
        "--host",
        "127.0.0.1",
        "--mode",
        "production",
        "--clearScreen",
        "false",
      ],
      web,
      { ...process.env, VITE_API_MODE: "http" },
    );
    console.log(
      "[Atelier] Browser URL: http://127.0.0.1:5173 (wait for API startup to finish).",
    );
  }
}

main().catch((error) => {
  console.error(`[Atelier] ${error.message}`);
  process.exitCode = 1;
});
