/**
 * Skills 管理路由
 *
 * GET    /api/skills              — 列出所有可用 skill（含当前 agent 的 enabled 状态）
 * PUT    /api/agents/:id/skills   — 同步指定 agent 的 skills 目录（按 enabled 列表复制/移除）
 * POST   /api/skills/install      — 安装用户技能（文件夹路径 / .zip / .skill）
 * POST   /api/skills/clawhub/search  — 通过 ClawHub 搜索技能
 * POST   /api/skills/clawhub/install — 通过 ClawHub 安装技能
 * DELETE /api/skills/:name        — 删除用户技能
 */
import path from "path";
import fs from "fs";
import { spawn, execFileSync } from "child_process";
import { createRequire } from "module";
import { extractZip } from "../../lib/extract-zip.js";
import { saveConfig } from "../../lib/memory/config-loader.js";
import { sanitizeSkillName } from "../../lib/skills/skill-name.js";
import { t } from "../i18n.js";

const CLAWHUB_JOB_KEEP_MS = 30 * 60_000;
const CLAWHUB_STARS_CACHE_TTL_MS = 15 * 60_000;
const CLAWHUB_STARS_CACHE_FAIL_TTL_MS = 2 * 60_000;
const clawhubInstallJobs = new Map();
const clawhubStarsCache = new Map();
const require = createRequire(import.meta.url);
let cachedNpxBin = null;
let cachedBundledClawhubCli = undefined;

function resolveNpxFromLoginShell() {
  if (process.platform === "win32") return null;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const found = execFileSync(shell, ["-l", "-c", "command -v npx || true"], {
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    if (!found) return null;
    const line = found.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    return line || null;
  } catch {
    return null;
  }
}

function getNpxBin() {
  if (cachedNpxBin) return cachedNpxBin;
  const byNode = process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "npx.cmd")
    : path.join(path.dirname(process.execPath), "npx");
  if (fs.existsSync(byNode)) {
    cachedNpxBin = byNode;
    return cachedNpxBin;
  }
  const fromShell = resolveNpxFromLoginShell();
  if (fromShell) {
    cachedNpxBin = fromShell;
    return cachedNpxBin;
  }
  cachedNpxBin = process.platform === "win32" ? "npx.cmd" : "npx";
  return cachedNpxBin;
}

function resolveBundledClawhubCli() {
  if (cachedBundledClawhubCli !== undefined) return cachedBundledClawhubCli;
  try {
    const resolved = require.resolve("clawhub/dist/cli.js");
    cachedBundledClawhubCli = fs.existsSync(resolved) ? resolved : null;
  } catch {
    cachedBundledClawhubCli = null;
  }
  return cachedBundledClawhubCli;
}

function stripNpxWrapperArgs(args = []) {
  const list = Array.isArray(args) ? args.map((v) => String(v)) : [];
  if (list.length >= 2 && list[0] === "--yes" && /^clawhub(?:@[\w.-]+)?$/i.test(list[1])) {
    return list.slice(2);
  }
  if (list.length >= 1 && /^clawhub(?:@[\w.-]+)?$/i.test(list[0])) {
    return list.slice(1);
  }
  return list;
}

function validateId(id) {
  return id && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}

function agentExists(engine, id) {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}

/** 从 SKILL.md frontmatter 解析 name */
function parseSkillName(skillMdPath) {
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    return nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

function parseSkillNameFromContent(content) {
  if (!content) return null;
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/mi);
    if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, "");
  }
  const commentMatch = content.match(/<!--\s*name:\s*(.+?)\s*-->/i);
  if (commentMatch) return commentMatch[1].trim();
  const headingMatch = content.match(/^#\s+(.+?)$/m);
  if (headingMatch) return headingMatch[1].trim();
  return null;
}

function guessSkillDescription(content, fallback = "Imported skill") {
  if (!content) return fallback;
  const noCode = content.replace(/```[\s\S]*?```/g, "\n");
  const lines = noCode.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("---")) continue;
    if (/^name:\s*/i.test(line)) continue;
    if (line.length < 4) continue;
    return line.slice(0, 200);
  }
  return fallback;
}

function yamlQuote(v) {
  return String(v || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * 兼容无 frontmatter 的第三方 SKILL.md：
 * 自动补齐最小 frontmatter，确保资源加载器可识别。
 */
function ensureSkillFrontmatter(skillMdPath, fallbackNameRaw) {
  try {
    if (!fs.existsSync(skillMdPath)) return null;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fallbackName = sanitizeSkillName(fallbackNameRaw || "") || "imported-skill";
    const candidateName = parseSkillNameFromContent(content) || fallbackName;
    const safeName = sanitizeSkillName(candidateName) || fallbackName;
    const desc = guessSkillDescription(content, safeName);

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (fmMatch) {
      const fmBody = fmMatch[1];
      const hasValidName = !!(fmBody.match(/^name:\s*(.+)$/mi)?.[1]?.trim()
        && sanitizeSkillName(fmBody.match(/^name:\s*(.+)$/mi)[1].trim().replace(/^["']|["']$/g, "")));
      if (hasValidName) return safeName;
      const body = content.slice(fmMatch[0].length);
      const nextFm = `${fmBody.trim()}\nname: "${yamlQuote(safeName)}"`;
      const rewritten = `---\n${nextFm}\n---\n\n${body}`;
      fs.writeFileSync(skillMdPath, rewritten, "utf-8");
      return safeName;
    }

    const normalized = `---\nname: "${yamlQuote(safeName)}"\ndescription: "${yamlQuote(desc)}"\n---\n\n${content}`;
    fs.writeFileSync(skillMdPath, normalized, "utf-8");
    return safeName;
  } catch {
    return null;
  }
}

/** 递归复制目录 */
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** 递归删除目录 */
function rmDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function parseSkillLine(line) {
  // 输出示例: "code  Code  (3.634)"
  const m = line.trim().match(/^([^\s]+)\s+(.+?)\s+\(([-+]?\d+(?:\.\d+)?)\)$/);
  if (!m) return null;
  return {
    slug: m[1],
    name: m[2],
    score: Number(m[3]),
  };
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function findLoadedSkill(engine, { name, baseDir }) {
  const all = engine.getAllSkills();
  const targetDir = baseDir ? safeRealpath(baseDir) : null;
  if (targetDir) {
    const byDir = all.find((s) => {
      const skillDir = s.baseDir || (s.filePath ? path.dirname(s.filePath) : null);
      if (!skillDir) return false;
      const real = safeRealpath(skillDir);
      return !!real && real === targetDir;
    });
    if (byDir) return byDir;
  }
  if (name) {
    const byName = all.find((s) => s.name === name);
    if (byName) return byName;
  }
  return null;
}

function scanSkillDirs(baseDir, maxDepth = 5) {
  const results = [];
  const seen = new Set();
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      const real = fs.realpathSync(dir);
      if (!seen.has(real)) {
        seen.add(real);
        results.push(dir);
      }
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }
  walk(baseDir, 0);
  return results;
}

function runNpxClawhub(args, opts = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 90_000,
    onStdoutLine,
    onStderrLine,
  } = opts;

  const registry = "https://registry.npmjs.org";
  const rawArgs = Array.isArray(args) ? args.map((v) => String(v)) : [];
  const localClawhubArgs = stripNpxWrapperArgs(rawArgs);
  const bundledCli = resolveBundledClawhubCli();

  return new Promise((resolve, reject) => {
    const spawnWithCapture = ({ bin, argv, missingHint }) => {
      const env = {
        ...process.env,
        npm_config_registry: registry,
        NPM_CONFIG_REGISTRY: registry,
      };
      if (bin === process.execPath && argv[0] === bundledCli) {
        // 用 Electron/Node 自身运行本地 clawhub CLI，不依赖系统 npx/node。
        env.ELECTRON_RUN_AS_NODE = "1";
      }
      const child = spawn(bin, argv, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let stdoutRest = "";
      let stderrRest = "";

      const flushLine = (line, cb) => {
        const text = String(line || "").trim();
        if (!text || !cb) return;
        cb(text);
      };
      const appendChunk = (chunk, rest, cb) => {
        const text = String(chunk || "");
        const normalized = (rest + text).replace(/\r/g, "\n");
        const parts = normalized.split("\n");
        const tail = parts.pop() || "";
        for (const part of parts) flushLine(part, cb);
        return tail;
      };
      const onOut = (buf) => {
        const text = String(buf);
        stdout += text;
        stdoutRest = appendChunk(text, stdoutRest, onStdoutLine);
      };
      const onErr = (buf) => {
        const text = String(buf);
        stderr += text;
        stderrRest = appendChunk(text, stderrRest, onStderrLine);
      };
      child.stdout.on("data", onOut);
      child.stderr.on("data", onErr);

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("clawhub command timeout"));
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        if (err?.code === "ENOENT" && missingHint) {
          reject(new Error(missingHint));
          return;
        }
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        flushLine(stdoutRest, onStdoutLine);
        flushLine(stderrRest, onStderrLine);
        const out = stdout.trim();
        const err = stderr.trim();
        if (code === 0) {
          resolve({ stdout: out, stderr: err });
          return;
        }
        reject(new Error(err || out || `clawhub exited with code ${code}`));
      });
    };

    if (bundledCli) {
      spawnWithCapture({
        bin: process.execPath,
        argv: [bundledCli, ...localClawhubArgs],
        missingHint: "bundled clawhub CLI not found in app package",
      });
      return;
    }

    const bin = getNpxBin();
    const npxMissingHint = process.platform === "win32"
      ? "npx command not found; please ensure Node.js/npm is installed and available in PATH"
      : "npx command not found; please ensure Node.js/npm is installed (or launch app from a login shell)";
    spawnWithCapture({
      bin,
      argv: rawArgs,
      missingHint: npxMissingHint,
    });
  });
}

function parseClawhubJsonOutput(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(msg) {
  const m = String(msg || "").match(/retry in\s+(\d+)(?:\.\d+)?s/i);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

async function runNpxClawhubWithRetry(args, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 3));
  const onRetry = typeof opts.onRetry === "function" ? opts.onRetry : null;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await runNpxClawhub(args, opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      if (i >= retries) break;
      const shouldRetry = /rate limit/i.test(msg) || /network/i.test(msg);
      if (!shouldRetry) break;
      const waitMs = parseRetryDelayMs(msg) ?? 1200;
      onRetry?.({ attempt: i + 1, retries, waitMs, message: msg });
      await sleep(waitMs);
    }
  }
  throw lastErr || new Error("clawhub command failed");
}

function classifyClawhubError(err) {
  const message = String(err?.message || err || "clawhub request failed");
  if (/rate limit/i.test(message)) {
    return { status: 429, error: message };
  }
  if (/bundled clawhub cli not found/i.test(message)) {
    return { status: 503, error: message };
  }
  if (/npx command not found/i.test(message) || /spawn\s+\S*npx\S*\s+ENOENT/i.test(message)) {
    return { status: 503, error: message };
  }
  if (/timeout/i.test(message)) {
    return { status: 504, error: message };
  }
  return { status: 500, error: message };
}

function createClawhubInstallJob(slug) {
  const id = `clawhub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const job = {
    id,
    slug,
    status: "queued",
    progress: 0,
    message: "queued",
    error: null,
    skill: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  clawhubInstallJobs.set(id, job);
  return job;
}

function getActiveClawhubInstallJob(slug) {
  for (const job of clawhubInstallJobs.values()) {
    if (job.slug !== slug) continue;
    if (job.status === "queued" || job.status === "running") return job;
  }
  return null;
}

function updateClawhubInstallJob(jobId, patch = {}) {
  const job = clawhubInstallJobs.get(jobId);
  if (!job) return null;
  const next = { ...job, ...patch, updatedAt: Date.now() };
  clawhubInstallJobs.set(jobId, next);
  return next;
}

function finishClawhubInstallJob(jobId, patch = {}) {
  const now = Date.now();
  const next = updateClawhubInstallJob(jobId, { ...patch, finishedAt: now });
  if (!next) return null;
  setTimeout(() => {
    const cur = clawhubInstallJobs.get(jobId);
    if (!cur) return;
    const terminal = cur.status === "succeeded" || cur.status === "failed";
    if (!terminal) return;
    if ((cur.finishedAt || 0) + CLAWHUB_JOB_KEEP_MS > Date.now()) return;
    clawhubInstallJobs.delete(jobId);
  }, CLAWHUB_JOB_KEEP_MS + 1000);
  return next;
}

function parseClawhubInstallPhase(line = "") {
  const text = String(line || "").trim();
  if (!text) return null;
  if (/rate limit/i.test(text)) return { progress: 38, message: text };
  if (/resolving/i.test(text)) return { progress: 24, message: text };
  if (/fetching|downloading/i.test(text)) return { progress: 38, message: text };
  if (/extracting|writing|copying|installing/i.test(text)) return { progress: 52, message: text };
  if (/done|completed|success/i.test(text)) return { progress: 68, message: text };
  return { progress: 20, message: text };
}

function clampProgress(n, fallback = 0) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, num));
}

function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Number(limit) || 1);
  const out = new Array(list.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(max, list.length) }, async () => {
    while (true) {
      const cur = idx++;
      if (cur >= list.length) break;
      out[cur] = await mapper(list[cur], cur);
    }
  });
  return Promise.all(workers).then(() => out);
}

async function getClawhubStars(slug) {
  const key = String(slug || "").trim();
  if (!key) return null;
  const cached = clawhubStarsCache.get(key);
  if (cached && cached.expireAt > Date.now()) return cached.value;
  try {
    const res = await runNpxClawhubWithRetry([
      "--yes",
      "clawhub@latest",
      "inspect",
      key,
      "--json",
    ], {
      timeoutMs: 45_000,
      retries: 1,
    });
    const json = parseClawhubJsonOutput(res.stdout);
    const starsRaw = json?.skill?.stats?.stars;
    const stars = Number.isFinite(Number(starsRaw)) ? Number(starsRaw) : null;
    clawhubStarsCache.set(key, {
      value: stars,
      expireAt: Date.now() + CLAWHUB_STARS_CACHE_TTL_MS,
    });
    return stars;
  } catch {
    clawhubStarsCache.set(key, {
      value: null,
      expireAt: Date.now() + CLAWHUB_STARS_CACHE_FAIL_TTL_MS,
    });
    return null;
  }
}

async function installByClawhubInspect(slug, tmpDir, onProgress) {
  const inspectArgs = [
    "--yes",
    "clawhub@latest",
    "inspect",
    slug,
    "--files",
    "--json",
  ];
  onProgress?.(70, "Using inspect fallback");
  const inspectRes = await runNpxClawhubWithRetry(inspectArgs, {
    timeoutMs: 180_000,
    retries: 2,
    onRetry: ({ waitMs, message }) => {
      onProgress?.(72, `Inspect retry in ${Math.ceil(waitMs / 1000)}s: ${message}`);
    },
  });
  const inspectJson = parseClawhubJsonOutput(inspectRes.stdout);
  const files = (inspectJson?.version?.files || [])
    .map((f) => String(f?.path || ""))
    .filter(Boolean);
  if (!files.includes("SKILL.md")) {
    throw new Error("inspect missing SKILL.md");
  }

  const slugLeaf = sanitizeSkillName(String(slug).split("/").pop() || "") || "inspect-skill";
  const installRoot = path.join(tmpDir, ".inspect-download", slugLeaf);
  fs.mkdirSync(installRoot, { recursive: true });

  for (const relPath of files) {
    const fileArgs = [
      "--yes",
      "clawhub@latest",
      "inspect",
      slug,
      "--file",
      relPath,
      "--json",
    ];
    const fileRes = await runNpxClawhubWithRetry(fileArgs, {
      timeoutMs: 180_000,
      retries: 2,
      onRetry: ({ waitMs, message }) => {
        onProgress?.(76, `Inspect file retry in ${Math.ceil(waitMs / 1000)}s: ${message}`);
      },
    });
    const fileJson = parseClawhubJsonOutput(fileRes.stdout);
    const content = fileJson?.file?.content;
    if (typeof content !== "string") {
      throw new Error(`inspect file content missing: ${relPath}`);
    }
    const dst = path.resolve(installRoot, relPath);
    if (!(dst === installRoot || dst.startsWith(installRoot + path.sep))) {
      throw new Error(`invalid inspect file path: ${relPath}`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, "utf-8");
    onProgress?.(80, `Fetched ${relPath}`);
  }

  return installRoot;
}

async function installClawhubSkill({ engine, skillSlug, onProgress }) {
  const userDir = engine.userSkillsDir || engine.skillsDir;
  let tmpDir = null;
  try {
    fs.mkdirSync(userDir, { recursive: true });
    onProgress?.(6, "Preparing install workspace");
    tmpDir = fs.mkdtempSync(path.join(userDir, ".tmp-clawhub-install-"));

    const onLine = (line) => {
      const phase = parseClawhubInstallPhase(line);
      if (!phase) return;
      onProgress?.(phase.progress, phase.message);
    };
    const onRetry = ({ waitMs, message }) => {
      onProgress?.(40, `Retrying in ${Math.ceil(waitMs / 1000)}s: ${message}`);
    };

    const argsPrimary = [
      "--yes",
      "clawhub@latest",
      "install",
      skillSlug,
      "--workdir",
      tmpDir,
      "--dir",
      ".",
      "--no-input",
      "--force",
    ];
    const argsFallback = [
      "--yes",
      "clawhub@latest",
      "install",
      skillSlug,
      "--workdir",
      tmpDir,
      "--dir",
      "skills",
      "--no-input",
      "--force",
    ];

    onProgress?.(14, "Installing from ClawHub");
    try {
      await runNpxClawhubWithRetry(argsPrimary, {
        timeoutMs: 180_000,
        retries: 3,
        onStdoutLine: onLine,
        onStderrLine: onLine,
        onRetry,
      });
    } catch (_primaryErr) {
      onProgress?.(58, "Retry install path: skills/");
      try {
        await runNpxClawhubWithRetry(argsFallback, {
          timeoutMs: 180_000,
          retries: 3,
          onStdoutLine: onLine,
          onStderrLine: onLine,
          onRetry,
        });
      } catch (_fallbackErr) {
        onProgress?.(66, "Falling back to inspect download");
        await installByClawhubInspect(skillSlug, tmpDir, onProgress);
      }
    }

    onProgress?.(82, "Scanning installed files");
    const candidates = scanSkillDirs(tmpDir, 10);
    if (!candidates.length) {
      throw new Error("clawhub install succeeded but no SKILL.md found");
    }

    const slugLeaf = skillSlug.split("/").pop()?.toLowerCase() || skillSlug.toLowerCase();
    candidates.sort((a, b) => {
      const an = path.basename(a).toLowerCase();
      const bn = path.basename(b).toLowerCase();
      const as = an === slugLeaf ? 1 : 0;
      const bs = bn === slugLeaf ? 1 : 0;
      if (as !== bs) return bs - as;
      return a.length - b.length;
    });

    const skillDir = candidates[0];
    const skillMdPath = path.join(skillDir, "SKILL.md");
    ensureSkillFrontmatter(skillMdPath, skillSlug.split("/").pop() || path.basename(skillDir));
    const rawName = parseSkillName(skillMdPath) || path.basename(skillDir);
    const safeName = sanitizeSkillName(rawName) || sanitizeSkillName(path.basename(skillDir));
    if (!safeName) {
      throw new Error(t("error.skillNameInvalid", { name: rawName }));
    }

    const dstDir = path.join(userDir, safeName);
    onProgress?.(88, "Writing skill files");
    if (fs.existsSync(dstDir)) rmDirSync(dstDir);
    copyDirSync(skillDir, dstDir);

    onProgress?.(94, "Reloading skills");
    await engine.reloadSkills();
    const skill = findLoadedSkill(engine, { name: safeName, baseDir: dstDir });
    if (!skill) {
      if (fs.existsSync(dstDir)) rmDirSync(dstDir);
      await engine.reloadSkills();
      throw new Error("skill format is incompatible or missing valid YAML frontmatter");
    }
    onProgress?.(100, "Install complete");
    return skill;
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      rmDirSync(tmpDir);
    }
  }
}

export default async function skillsRoute(app, { engine }) {

  app.get("/api/skills", async (req, reply) => {
    try {
      const { agentId } = req.query;
      return { skills: engine.getAllSkills(agentId || undefined) };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/skills", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const { enabled } = req.body || {};
      if (!Array.isArray(enabled)) {
        reply.code(400);
        return { error: "enabled must be an array of skill names" };
      }

      const normalized = [];
      const seen = new Set();
      for (const raw of enabled) {
        const name = sanitizeSkillName(String(raw || ""));
        if (!name) {
          reply.code(400);
          return { error: `invalid skill name: ${raw}` };
        }
        if (!seen.has(name)) {
          seen.add(name);
          normalized.push(name);
        }
      }

      const catalog = engine.getAllSkills();
      const catalogMap = new Map();
      for (const s of catalog) {
        if (!s?.name) continue;
        const baseDir = s.baseDir || (s.filePath ? path.dirname(s.filePath) : null);
        if (!baseDir || !fs.existsSync(baseDir)) continue;
        catalogMap.set(s.name, baseDir);
      }

      const agentSkillsDir = path.join(engine.agentsDir, id, "skills");
      fs.mkdirSync(agentSkillsDir, { recursive: true });

      // 先校验：所有要启用的技能都必须能在全局仓库找到
      const copyPlan = [];
      for (const name of normalized) {
        const dstDir = path.join(agentSkillsDir, name);
        const srcDir = catalogMap.get(name);
        if (!srcDir) {
          // 允许保留“仅本地 skill”（已存在于该 agent 私有目录）
          if (fs.existsSync(path.join(dstDir, "SKILL.md"))) {
            continue;
          }
          reply.code(400);
          return { error: `skill not found in global repository: ${name}` };
        }
        copyPlan.push({ name, srcDir, dstDir });
      }

      // 复制新增技能到 agent 私有目录（已存在则保留，不覆盖）
      for (const item of copyPlan) {
        if (!fs.existsSync(item.dstDir)) {
          copyDirSync(item.srcDir, item.dstDir);
        }
      }

      // 删除已移除技能（agent 私有目录中不在 enabled 列表里的目录）
      const keepSet = new Set(normalized);
      for (const entry of fs.readdirSync(agentSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (keepSet.has(entry.name)) continue;
        rmDirSync(path.join(agentSkillsDir, entry.name));
      }

      // 重新加载：让运行时扫描各 agent 的私有 skills
      await engine.reloadSkills();

      // 兼容保留：同步写入 config.skills.enabled，避免旧逻辑读取不到
      const partial = { skills: { enabled: normalized } };
      if (id === engine.currentAgentId) {
        await engine.updateConfig(partial);
      } else {
        const targetAgent = engine.getAgent?.(id);
        if (targetAgent?.updateConfig) {
          targetAgent.updateConfig(partial);
          engine._skills?.syncAgentSkills?.(targetAgent);
        } else {
          const configPath = path.join(engine.agentsDir, id, "config.yaml");
          saveConfig(configPath, partial);
        }
      }

      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 安装用户技能 ──
  app.post("/api/skills/install", async (req, reply) => {
    try {
      const { path: srcPath } = req.body || {};
      if (!srcPath || !path.isAbsolute(srcPath)) {
        reply.code(400);
        return { error: t("error.skillNeedAbsolutePath") };
      }

      if (!fs.existsSync(srcPath)) {
        reply.code(400);
        return { error: t("error.skillPathNotExists") };
      }

      const userDir = engine.userSkillsDir;
      const stat = fs.statSync(srcPath);

      let skillDir; // 最终包含 SKILL.md 的目录

      if (stat.isDirectory()) {
        // 直接是文件夹
        if (!fs.existsSync(path.join(srcPath, "SKILL.md"))) {
          reply.code(400);
          return { error: t("error.skillMissingSkillMd") };
        }
        skillDir = srcPath;
      } else {
        // .zip 或 .skill 文件
        const ext = path.extname(srcPath).toLowerCase();
        if (ext !== ".zip" && ext !== ".skill") {
          reply.code(400);
          return { error: t("error.skillUnsupportedFormat") };
        }

        // 解压到临时目录
        const tmpDir = path.join(userDir, ".tmp-install-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
          extractZip(srcPath, tmpDir);

          // 找到 SKILL.md：可能在根目录或一层子目录内
          if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
            skillDir = tmpDir;
          } else {
            const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
              .filter(e => e.isDirectory() && !e.name.startsWith("."));
            const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
            if (found) {
              skillDir = path.join(tmpDir, found.name);
            } else {
              rmDirSync(tmpDir);
              reply.code(400);
              return { error: t("error.skillMissingSkillMdInZip") };
            }
          }
        } catch (err) {
          rmDirSync(tmpDir);
          reply.code(400);
          return { error: t("error.skillExtractFailed", { msg: err.message }) };
        }
      }

      const skillMdPath = path.join(skillDir, "SKILL.md");
      // 兼容第三方无 frontmatter 的 SKILL.md，自动补齐最小 frontmatter
      ensureSkillFrontmatter(skillMdPath, path.basename(skillDir));
      // 解析技能名称
      const skillName = parseSkillName(skillMdPath);
      if (!skillName) {
        // 清理临时目录
        if (skillDir !== srcPath) rmDirSync(path.dirname(skillDir) === userDir ? skillDir : path.join(userDir, ".tmp-install-" + Date.now()));
        reply.code(400);
        return { error: t("error.skillMissingName") };
      }

      // 安全校验名称
      const safeName = sanitizeSkillName(skillName);
      if (!safeName) {
        reply.code(400);
        return { error: t("error.skillNameInvalid", { name: skillName }) };
      }

      // 手动安装（用户行为）不做安全审查，直接放行

      // 复制到用户技能目录
      const dstDir = path.join(userDir, safeName);
      if (skillDir === srcPath) {
        // 文件夹模式：复制
        copyDirSync(skillDir, dstDir);
      } else {
        // zip 解压模式：移动（从临时目录）
        if (fs.existsSync(dstDir)) rmDirSync(dstDir);
        fs.renameSync(skillDir, dstDir);
        // 清理临时目录残留
        const tmpParent = skillDir.includes(".tmp-install-")
          ? (path.dirname(skillDir).includes(".tmp-install-") ? path.dirname(skillDir) : null)
          : path.dirname(skillDir);
        // 简单处理：找到 .tmp-install- 前缀的目录并清理
        for (const entry of fs.readdirSync(userDir)) {
          if (entry.startsWith(".tmp-install-")) {
            rmDirSync(path.join(userDir, entry));
          }
        }
      }

      // 重新加载 skills
      await engine.reloadSkills();

      const skill = findLoadedSkill(engine, { name: safeName, baseDir: dstDir });
      if (!skill) {
        if (fs.existsSync(dstDir)) rmDirSync(dstDir);
        await engine.reloadSkills();
        reply.code(400);
        return { error: "skill format is incompatible or missing valid YAML frontmatter" };
      }
      return {
        ok: true,
        skill,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── ClawHub 搜索技能 ──
  app.post("/api/skills/clawhub/search", async (req, reply) => {
    try {
      const { query, limit } = req.body || {};
      const q = String(query || "").trim();
      if (!q) {
        reply.code(400);
        return { error: "query is required" };
      }

      const qParts = q.split(/\s+/).filter(Boolean);
      const finalLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
      const args = [
        "--yes",
        "clawhub@latest",
        "search",
        ...qParts,
        "--limit",
        String(finalLimit),
      ];
      const { stdout } = await runNpxClawhubWithRetry(args, {
        timeoutMs: 60_000,
        retries: 2,
      });

      const results = [];
      const seen = new Set();
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("-")) continue;
        const parsed = parseSkillLine(line);
        if (!parsed) continue;
        if (seen.has(parsed.slug)) continue;
        seen.add(parsed.slug);
        results.push(parsed);
      }

      const inspectCap = Math.min(results.length, 12);
      const enrichedHead = await mapLimit(results.slice(0, inspectCap), 3, async (item) => {
        const stars = await getClawhubStars(item.slug);
        return { ...item, stars };
      });
      const enrichedTail = results.slice(inspectCap).map((item) => ({ ...item, stars: null }));
      return { ok: true, results: [...enrichedHead, ...enrichedTail] };
    } catch (err) {
      const mapped = classifyClawhubError(err);
      reply.code(mapped.status);
      return { error: mapped.error };
    }
  });

  // ── ClawHub 安装技能（异步任务 + 进度查询） ──
  app.post("/api/skills/clawhub/install", async (req, reply) => {
    try {
      const { slug } = req.body || {};
      const skillSlug = String(slug || "").trim();
      if (!skillSlug) {
        reply.code(400);
        return { error: "slug is required" };
      }
      if (/\s/.test(skillSlug) || skillSlug.includes("..")) {
        reply.code(400);
        return { error: "invalid slug" };
      }

      const active = getActiveClawhubInstallJob(skillSlug);
      if (active) {
        return {
          ok: true,
          jobId: active.id,
          job: active,
          reused: true,
        };
      }

      const job = createClawhubInstallJob(skillSlug);
      updateClawhubInstallJob(job.id, {
        status: "running",
        progress: 4,
        message: "Task created",
      });

      // fire-and-forget 后台任务
      void (async () => {
        try {
          const skill = await installClawhubSkill({
            engine,
            skillSlug,
            onProgress: (progress, message) => {
              const prev = clawhubInstallJobs.get(job.id);
              const nextProgress = clampProgress(progress, prev?.progress || 0);
              updateClawhubInstallJob(job.id, {
                status: "running",
                progress: Math.max(prev?.progress || 0, nextProgress),
                message: message || prev?.message || "",
                error: null,
              });
            },
          });
          finishClawhubInstallJob(job.id, {
            status: "succeeded",
            progress: 100,
            message: "Install complete",
            skill,
            error: null,
          });
        } catch (err) {
          const prev = clawhubInstallJobs.get(job.id);
          finishClawhubInstallJob(job.id, {
            status: "failed",
            progress: clampProgress(prev?.progress, 0),
            message: "Install failed",
            error: String(err?.message || err || "unknown install error"),
          });
        }
      })();

      return {
        ok: true,
        jobId: job.id,
        job: clawhubInstallJobs.get(job.id),
      };
    } catch (err) {
      const mapped = classifyClawhubError(err);
      reply.code(mapped.status);
      return { error: mapped.error };
    }
  });

  app.get("/api/skills/clawhub/install/:jobId", async (req, reply) => {
    const { jobId } = req.params || {};
    const key = String(jobId || "").trim();
    if (!key) {
      reply.code(400);
      return { error: "jobId is required" };
    }
    const job = clawhubInstallJobs.get(key);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    return { ok: true, job };
  });

  // ── 删除技能 ──
  app.delete("/api/skills/:name", async (req, reply) => {
    try {
      const { name } = req.params;
      if (!sanitizeSkillName(name)) {
        reply.code(400);
        return { error: t("error.skillInvalidName") };
      }

      // 外部技能不可删除
      const allSkills = engine.getAllSkills();
      const target = allSkills.find(s => s.name === name);
      if (target?.readonly) {
        reply.code(403);
        return { error: t("error.skillExternalCannotDelete") };
      }

      // 只允许删除 .hanako/skills 下的安装技能
      const userSkillPath = path.join(engine.skillsDir, name);

      let skillPath;
      if (fs.existsSync(userSkillPath)) {
        skillPath = userSkillPath;
      } else {
        reply.code(404);
        return { error: t("error.skillNotExists") };
      }

      // 删除目录
      rmDirSync(skillPath);

      // 从所有 agent 的私有 skills 目录中移除，并兼容清理 enabled 列表
      const agentsDir = engine.agentsDir;
      for (const agentName of fs.readdirSync(agentsDir)) {
        const configPath = path.join(agentsDir, agentName, "config.yaml");
        if (!fs.existsSync(configPath)) continue;

        const agentSkillPath = path.join(agentsDir, agentName, "skills", name);
        if (fs.existsSync(agentSkillPath)) {
          rmDirSync(agentSkillPath);
        }

        try {
          const { loadConfig } = await import("../../lib/memory/config-loader.js");
          const cfg = loadConfig(configPath);
          const enabled = cfg?.skills?.enabled;
          if (Array.isArray(enabled) && enabled.includes(name)) {
            const filtered = enabled.filter(n => n !== name);
            saveConfig(configPath, { skills: { enabled: filtered } });
          }
        } catch (e) {
          console.error(`[skills] 清理 agent ${agentName} 的 skill 引用失败:`, e.message);
        }
      }

      // 重新加载 skills
      await engine.reloadSkills();

      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // POST /api/skills/reload — 强制重新加载所有技能
  app.post("/api/skills/reload", async (_req, reply) => {
    try {
      await engine.reloadSkills();
      return { ok: true, skills: engine.getAllSkills() };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // POST /api/skills/translate — 用工具模型翻译技能名
  app.post("/api/skills/translate", async (request, reply) => {
    const { names, lang } = request.body || {};
    if (!Array.isArray(names) || !lang || lang === "en") {
      return {};
    }
    return engine.translateSkillNames(names, lang);
  });
}
