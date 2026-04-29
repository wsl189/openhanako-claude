import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSourceRoot = path.join(__dirname, "runtime");

const runtimeStateRoot = path.join(os.homedir(), ".hanako", "computer-use-runtime");
const venvRoot = path.join(runtimeStateRoot, "venv");
const installStampPath = path.join(runtimeStateRoot, "requirements.sha256");

const isWindows = process.platform === "win32";
const requirementsPath = path.join(runtimeStateRoot, isWindows ? "requirements-win.txt" : "requirements.txt");
const helperFileName = isWindows ? "win_helper.py" : "mac_helper.py";
const helperPath = path.join(runtimeStateRoot, helperFileName);

let bootstrapPromise;

function pythonBinPath() {
  return isWindows
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python3");
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function runExec(file, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env || process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (buf) => {
      stdout += String(buf || "");
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf || "");
    });

    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error?.message || String(error)}`.trim() });
    });

    child.on("close", (code) => {
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

async function runOrThrow(file, args, label, opts = {}) {
  const { code, stdout, stderr } = await runExec(file, args, opts);
  if (code !== 0) {
    throw new Error(`${label} failed with code ${code}: ${stderr || stdout || "unknown error"}`);
  }
  return stdout;
}

async function ensureRuntimeFiles() {
  await mkdir(runtimeStateRoot, { recursive: true });

  const sourceRequirementsPath = path.join(
    runtimeSourceRoot,
    isWindows ? "requirements-win.txt" : "requirements.txt",
  );
  const sourceHelperPath = path.join(runtimeSourceRoot, helperFileName);

  const sourceRequirements = await readFile(sourceRequirementsPath, "utf8");
  await writeFile(requirementsPath, sourceRequirements, "utf8");

  const sourceHelper = await readFile(sourceHelperPath, "utf8");
  await writeFile(helperPath, sourceHelper, "utf8");
}

function pythonEnv() {
  if (!isWindows) return process.env;
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

export async function ensureBootstrapped() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    await ensureRuntimeFiles();

    if (!(await pathExists(pythonBinPath()))) {
      const pythonCmd = isWindows ? "python" : "python3";
      await runOrThrow(pythonCmd, ["-m", "venv", venvRoot], "python venv creation", { env: pythonEnv() });
    }

    const requirements = await readFile(requirementsPath, "utf8");
    const digest = createHash("sha256").update(requirements).digest("hex");

    let installedDigest = "";
    try {
      installedDigest = String(await readFile(installStampPath, "utf8")).trim();
    } catch {
      installedDigest = "";
    }

    if (installedDigest !== digest) {
      const pybin = pythonBinPath();
      await runOrThrow(pybin, ["-m", "pip", "install", "--upgrade", "pip"], "pip upgrade", { env: pythonEnv() });
      await runOrThrow(pybin, ["-m", "pip", "install", "-r", requirementsPath], "python dependency install", { env: pythonEnv() });
      await writeFile(installStampPath, `${digest}\n`, "utf8");
    }
  })();

  try {
    await bootstrapPromise;
  } catch (error) {
    bootstrapPromise = undefined;
    throw error;
  }
}

export async function callPythonHelper(command, payload = {}) {
  await ensureBootstrapped();

  const pybin = pythonBinPath();
  const { code, stdout, stderr } = await runExec(
    pybin,
    [helperPath, command, "--payload", JSON.stringify(payload)],
    { env: pythonEnv() },
  );

  if (code !== 0 && !String(stdout || "").trim()) {
    throw new Error(stderr || `Python helper ${command} failed with code ${code}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "{}"));
  } catch {
    throw new Error(stderr || stdout || `Python helper ${command} returned invalid JSON`);
  }

  if (!parsed?.ok) {
    throw new Error(parsed?.error?.message || `Python helper ${command} failed`);
  }

  return parsed.result;
}

export function getRuntimePaths() {
  return {
    runtimeSourceRoot,
    runtimeStateRoot,
    venvRoot,
  };
}
