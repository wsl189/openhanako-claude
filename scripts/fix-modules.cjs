/**
 * fix-modules.cjs — electron-builder afterPack 钩子
 *
 * electron-builder 的依赖分析有时会漏掉新的子依赖。
 * 这个脚本在打包后检查 dist node_modules，把缺失的
 * 生产依赖从本地 node_modules 拷贝过去。
 */

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function resolveElectronBuilderArch(arch) {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
  if (typeof arch === "string") return arch;
  if (arch === 3) return "arm64";
  if (arch === 0) return "ia32";
  return "x64";
}

function copyDirectory(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function installPackageFromNpm(packageName, version, destPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-native-pkg-"));
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const raw = execFileSync(npmCmd, [
      "pack",
      `${packageName}@${version}`,
      "--json",
      "--force",
      "--pack-destination",
      tmpDir,
    ], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const info = JSON.parse(raw)[0];
    const tarball = path.join(tmpDir, info.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", tmpDir], { stdio: "ignore" });
    copyDirectory(path.join(tmpDir, "package"), destPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function ensureClaudeAgentSdkNativePackage({ platformName, archName, distModules, localModules }) {
  if (platformName !== "win" && platformName !== "windows") return;
  if (archName !== "x64" && archName !== "arm64") return;

  const sdkPackageJsonPath = path.join(localModules, "@anthropic-ai", "claude-agent-sdk", "package.json");
  if (!fs.existsSync(sdkPackageJsonPath)) return;

  const sdkVersion = readJson(sdkPackageJsonPath).version;
  const nativePackageName = `@anthropic-ai/claude-agent-sdk-win32-${archName}`;
  const nativePackageSubpath = path.join("@anthropic-ai", `claude-agent-sdk-win32-${archName}`);
  const distPath = path.join(distModules, nativePackageSubpath);
  if (fs.existsSync(path.join(distPath, "claude.exe"))) return;

  const localPath = path.join(localModules, nativePackageSubpath);
  if (fs.existsSync(path.join(localPath, "claude.exe"))) {
    copyDirectory(localPath, distPath);
    console.log(`[fix-modules] 已补全 ${nativePackageName}`);
    return;
  }

  console.log(`[fix-modules] 正在下载 ${nativePackageName}@${sdkVersion}（Windows Claude Code 原生运行时）`);
  try {
    installPackageFromNpm(nativePackageName, sdkVersion, distPath);
  } catch (err) {
    throw new Error(
      `[fix-modules] 无法补全 ${nativePackageName}@${sdkVersion}。`
      + " Windows 版缺少该原生包会导致 Claude Code process exited with code 1。"
      + ` 原始错误: ${err.message}`,
    );
  }
}

exports.default = async function (context) {
  const platformName = context.packager.platform.name;
  const appDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources", "app")
    : path.join(context.appOutDir, "resources", "app");
  const distModules = path.join(appDir, "node_modules");
  const localModules = path.resolve(__dirname, "..", "node_modules");
  const archName = resolveElectronBuilderArch(context.arch);

  if (!fs.existsSync(distModules)) return;

  // 获取生产依赖树
  let prodDeps;
  try {
    const raw = execSync("npm ls --all --json --omit=dev", {
      cwd: path.resolve(__dirname, ".."),
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    prodDeps = JSON.parse(raw);
  } catch (e) {
    // npm ls 在有 peer dep 警告时也会 exit 1，但 stdout 仍有数据
    try {
      prodDeps = JSON.parse(e.stdout?.toString() || "{}");
    } catch {
      console.log("[fix-modules] 无法解析依赖树，跳过");
      return;
    }
  }

  function collectDeps(obj, set = new Set()) {
    if (!obj || !obj.dependencies) return set;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      set.add(name);
      collectDeps(info, set);
    }
    return set;
  }

  const allProd = collectDeps(prodDeps);
  let copied = 0;

  // 含 native binding 的包（需要平台匹配编译），补全时额外警告
  const NATIVE_PACKAGES = new Set(["better-sqlite3", "bufferutil", "utf-8-validate"]);

  for (const dep of allProd) {
    const distPath = path.join(distModules, dep);
    const localPath = path.join(localModules, dep);
    if (!fs.existsSync(distPath) && fs.existsSync(localPath)) {
      if (NATIVE_PACKAGES.has(dep)) {
        console.warn(`[fix-modules] ⚠ 补全 native 包 "${dep}"（确保已通过 electron-rebuild 编译）`);
      }
      fs.cpSync(localPath, distPath, { recursive: true });
      copied++;
    }
  }

  if (copied > 0) {
    console.log(`[fix-modules] 补全了 ${copied} 个缺失的生产依赖`);
  }

  ensureClaudeAgentSdkNativePackage({
    platformName,
    archName,
    distModules,
    localModules,
  });

  // 清理 node_modules 中指向 bundle 外部的 .bin 符号链接（codesign 会报错）
  let removedLinks = 0;
  function cleanBinLinks(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target) && !target.startsWith(appDir)) {
          fs.unlinkSync(full);
          removedLinks++;
        }
      } else if (entry.isDirectory() && entry.name !== ".bin") {
        // 递归进 node_modules 子目录，但跳过非 node_modules 的深层目录
        const binDir = path.join(full, "node_modules", ".bin");
        if (fs.existsSync(binDir)) cleanBinLinks(binDir);
      }
    }
  }

  // 扫描顶层和嵌套的 .bin 目录
  const topBin = path.join(distModules, ".bin");
  if (fs.existsSync(topBin)) cleanBinLinks(topBin);
  for (const entry of fs.readdirSync(distModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(distModules, entry.name, "node_modules", ".bin");
    if (fs.existsSync(nested)) cleanBinLinks(nested);
  }

  if (removedLinks > 0) {
    console.log(`[fix-modules] 清理了 ${removedLinks} 个指向 bundle 外部的 .bin 符号链接`);
  }
};
