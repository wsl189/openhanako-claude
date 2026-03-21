/**
 * boot.cjs — ESM 启动包装器
 *
 * 用 CJS 包装 ESM 入口，捕获模块加载阶段的错误（如 native module 缺失/ABI 不匹配）。
 * ESM 的 static import 失败时进程直接崩溃，无法输出任何诊断信息。
 * CJS 的 dynamic import() 可以 catch，让错误信息通过 stderr 传回 main 进程。
 */
(async () => {
  try {
    await import("./index.js");
  } catch (err) {
    console.error(`[server] 启动失败: ${err.message}`);
    if (err.code) console.error(`[server] 错误码: ${err.code}`);
    console.error(err.stack);

    // 诊断信息
    console.error(
      `[server] 诊断: platform=${process.platform} arch=${process.arch} ` +
      `node=${process.version} abi=${process.versions.modules}`
    );

    // 逐个检查关键 native module
    const nativeModules = ["better-sqlite3"];
    for (const mod of nativeModules) {
      try {
        require(mod);
        console.error(`[server] ${mod}: OK`);
      } catch (e) {
        console.error(`[server] ${mod}: 加载失败 - ${e.message}`);
      }
    }

    process.exit(1);
  }
})();
