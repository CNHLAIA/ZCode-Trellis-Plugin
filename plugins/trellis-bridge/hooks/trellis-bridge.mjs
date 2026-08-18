#!/usr/bin/env node
/**
 * 将 ZCode 插件 hook 委派给当前 Trellis checkout 中的
 * `.zcode/hooks/<script.py>`。payload、stdout、stderr 和退出码保持透传。
 *
 * 插件不复制 Trellis 业务逻辑。它只允许固定脚本名，并且仅在本地、
 * gitignored 的 `.trellis/.developer` 存在时执行项目脚本，避免打开一个
 * 尚未由用户初始化的仓库就运行其中的代码。
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

const ALLOWED_SCRIPTS = new Set([
  "session-start.py",
  "inject-workflow-state.py",
  "inject-subagent-context.py",
  "inject-shell-session-context.py",
]);

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findTrustedRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    const trellisDir = path.join(current, ".trellis");
    const developerFile = path.join(trellisDir, ".developer");
    if (existsSync(trellisDir) && isRegularFile(developerFile)) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseCommandLine(value) {
  const tokens = [];
  let token = "";
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && value[index + 1] === quote) {
        token += quote;
        index += 1;
      } else {
        token += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }

  if (quote) throw new Error("unterminated quote in TRELLIS_PYTHON_CMD");
  if (token) tokens.push(token);
  return tokens;
}

function getLaunchers() {
  const launchers = [];
  const explicitExecutable = process.env.TRELLIS_PYTHON?.trim();
  if (explicitExecutable) {
    const unquoted = explicitExecutable.replace(/^(["'])(.*)\1$/, "$2");
    launchers.push([unquoted]);
  }

  const explicitCommand = process.env.TRELLIS_PYTHON_CMD?.trim();
  if (explicitCommand) {
    try {
      const parsed = parseCommandLine(explicitCommand);
      if (parsed.length > 0) launchers.push(parsed);
    } catch (error) {
      process.stderr.write(`[trellis-bridge] ${error.message}\n`);
    }
  }

  if (process.platform === "win32") {
    // Keep `py -3` last: the Windows launcher can exist but have no registered
    // interpreter, in which case it exits 1 rather than raising ENOENT.
    launchers.push(["python"], ["python3"], ["py", "-3"]);
  } else {
    launchers.push(["python3"], ["python"]);
  }
  return launchers;
}

function getChildTimeoutMs(rawTimeout) {
  const hostTimeoutMs = Number(rawTimeout);
  const validHostTimeout =
    Number.isFinite(hostTimeoutMs) && hostTimeoutMs > 0 ? hostTimeoutMs : 25000;
  return Math.max(1000, validHostTimeout - 1000);
}

async function readInput() {
  return await new Promise((resolve) => {
    let raw = "";
    let finished = false;
    process.stdin.setEncoding("utf8");

    const onData = (chunk) => {
      raw += chunk;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      process.stdin.pause();
      resolve(raw);
    };
    const timer = setTimeout(finish, 500);
    timer.unref?.();
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
  });
}

function runLauncher(launcher, scriptPath, root, raw, timeoutMs) {
  return new Promise((resolve) => {
    const [command, ...prefixArgs] = launcher;
    const child = spawn(command, [...prefixArgs, scriptPath], {
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "timeout" });
    }, timeoutMs);

    child.once("error", (error) => {
      if (error.code === "ENOENT") {
        finish({ kind: "missing" });
        return;
      }
      finish({ kind: "error", error });
    });
    child.once("close", (code) => {
      finish({ kind: "closed", code: code ?? 0 });
    });

    child.stdin.on("error", () => {});
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdin.end(raw);
  });
}

async function main() {
  const scriptName = process.argv[2] ?? "";
  if (!ALLOWED_SCRIPTS.has(scriptName)) {
    process.stderr.write(
      `[trellis-bridge] refused unknown script: ${scriptName}\n`,
    );
    return 0;
  }

  const raw = await readInput();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const rootCandidates = [
    process.env.ZCODE_PROJECT_DIR,
    process.env.CLAUDE_PROJECT_DIR,
    typeof payload.cwd === "string" ? payload.cwd : null,
    process.cwd(),
  ].filter(Boolean);

  let root = null;
  for (const candidate of rootCandidates) {
    root = findTrustedRoot(candidate);
    if (root) break;
  }
  if (!root) return 0;

  const scriptPath = path.join(root, ".zcode", "hooks", scriptName);
  if (!isRegularFile(scriptPath)) return 0;

  const timeoutMs = getChildTimeoutMs(process.argv[3]);
  for (const launcher of getLaunchers()) {
    const result = await runLauncher(
      launcher,
      scriptPath,
      root,
      raw,
      timeoutMs,
    );
    if (result.kind === "missing") continue;
    if (result.kind === "timeout") {
      process.stderr.write(
        `[trellis-bridge] ${scriptName} timed out after ${timeoutMs}ms\n`,
      );
      return 124;
    }
    if (result.kind === "error") {
      process.stderr.write(
        `[trellis-bridge] spawn failed: ${result.error.message}\n`,
      );
      return 1;
    }
    return result.code;
  }

  process.stderr.write("[trellis-bridge] no python launcher found\n");
  return 127;
}

process.exitCode = await main();
