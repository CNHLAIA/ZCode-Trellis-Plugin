#!/usr/bin/env node
/**
 * 把 ZCode 插件 hook 委派给项目内
 * .zcode/hooks/<script.py>, payload 原样转发，stdout/stderr/退出码透传。
 *
 * 考虑到插件可能滞后于项目脚本, 本文件不加入 Trellis 业务逻辑;
 * 由于 ZCode 插件对所有工作区生效，非 Trellis 工作区或缺脚本会静默 exit 0。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ALLOWED_SCRIPTS = new Set([
  "session-start.py",
  "inject-workflow-state.py",
  "inject-subagent-context.py",
  "inject-shell-session-context.py",
]);

const scriptName = process.argv[2] ?? "";
if (!ALLOWED_SCRIPTS.has(scriptName)) {
  process.stderr.write(`[trellis-bridge] refused unknown script: ${scriptName}\n`);
  process.exit(0);
}
const timeoutMs = Math.max(1000, Number(process.argv[3] || 25000) - 1000); // 比宿主超时提前 1s kill 子进程，留出透传余量

// 容忍不关 stdin 的宿主, 参考 inject-workflow-state.py
const raw = await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => resolve(s));
  const t = setTimeout(() => resolve(s), 500);
  t.unref?.();
});
let payload = {};
try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }

function findRoot(start) {
  let cur = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(cur, ".trellis"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

const rootCandidates = [
  process.env.ZCODE_PROJECT_DIR,
  process.env.CLAUDE_PROJECT_DIR,
  typeof payload.cwd === "string" ? payload.cwd : null,
  process.cwd(),
].filter(Boolean);

let root = null;
for (const c of rootCandidates) {
  root = findRoot(c);
  if (root) break;
}
if (!root) process.exit(0);

const scriptPath = path.join(root, ".zcode", "hooks", scriptName);
if (!existsSync(scriptPath)) process.exit(0);

// 狗屎 Windows 兼容 python 命令
const launchers = [];
for (const v of ["TRELLIS_PYTHON", "TRELLIS_PYTHON_CMD"]) {
  if (process.env[v]) launchers.push(process.env[v].split(/\s+/));
}
launchers.push(process.platform === "win32" ? ["python"] : ["python3"]);
launchers.push(process.platform === "win32" ? ["python3"] : ["python"]);
if (process.platform === "win32") launchers.push(["py", "-3"]);

const childEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };

function delegate(i) {
  if (i >= launchers.length) {
    process.stderr.write("[trellis-bridge] no python launcher found\n");
    process.exit(127);
  }
  const [cmd, ...pre] = launchers[i];
  const child = spawn(cmd, [...pre, scriptPath], { cwd: root, env: childEnv });
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    child.kill();
    process.stderr.write(`[trellis-bridge] ${scriptName} timed out after ${timeoutMs}ms\n`);
    process.exit(124);
  }, timeoutMs);
  child.on("error", (err) => {
    if (settled) return;
    if (err.code === "ENOENT") { clearTimeout(timer); delegate(i + 1); return; }
    clearTimeout(timer);
    process.stderr.write(`[trellis-bridge] spawn failed: ${err.message}\n`);
    process.exit(1);
  });
  child.stdin.on("error", () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("close", (code) => {
    if (settled) return;
    clearTimeout(timer);
    process.exit(code ?? 0);
  });
  child.stdin.end(raw);
}
delegate(0);
