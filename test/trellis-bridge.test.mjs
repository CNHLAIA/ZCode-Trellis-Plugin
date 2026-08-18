import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bridgePath = path.join(
  repoRoot,
  "plugins",
  "trellis-bridge",
  "hooks",
  "trellis-bridge.mjs",
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function createCheckout({ trusted = true, hookSource } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-bridge-"));
  fs.mkdirSync(path.join(root, ".trellis"), { recursive: true });
  if (trusted) {
    fs.writeFileSync(path.join(root, ".trellis", ".developer"), "tester\n");
  }
  fs.mkdirSync(path.join(root, ".zcode", "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".zcode", "hooks", "inject-workflow-state.py"),
    hookSource ??
      "let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>process.stdout.write(raw));",
  );
  return root;
}

function runBridge(root, options = {}) {
  const payload =
    options.payload ?? JSON.stringify({ cwd: root, prompt: "hello" });
  return spawnSync(
    process.execPath,
    [bridgePath, "inject-workflow-state.py", options.hostTimeoutMs ?? "5000"],
    {
      cwd: root,
      encoding: "utf8",
      input: payload,
      env: {
        ...process.env,
        ZCODE_PROJECT_DIR: root,
        TRELLIS_PYTHON: options.python ?? process.execPath,
        TRELLIS_PYTHON_CMD: options.pythonCommand,
      },
    },
  );
}

test("marketplace and plugin manifests expose one versioned bridge", () => {
  const marketplace = readJson("marketplace.json");
  const plugin = readJson(
    path.join("plugins", "trellis-bridge", ".zcode-plugin", "plugin.json"),
  );
  const packageManifest = readJson("package.json");

  assert.equal(marketplace.metadata.pluginRoot, "plugins");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "trellis-bridge");
  assert.equal(marketplace.plugins[0].source, "./trellis-bridge");
  assert.equal(marketplace.plugins[0].version, plugin.version);
  assert.equal(plugin.version, packageManifest.version);
});

test("declares the MIT license and HLAIA copyright", () => {
  const packageManifest = readJson("package.json");
  const license = fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8");

  assert.equal(packageManifest.license, "MIT");
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 HLAIA/);
  assert.match(license, /to use, copy, modify, merge, publish, distribute/);
  assert.doesNotMatch(license, /noncommercial|commercial use is not permitted/i);
});

test("hook registrations pass the host timeout exactly once", () => {
  const manifest = readJson(
    path.join("plugins", "trellis-bridge", "hooks", "hooks.json"),
  );
  const registrations = Object.values(manifest.hooks).flatMap((entries) =>
    entries.flatMap((entry) => entry.hooks),
  );

  assert.equal(registrations.length, 4);
  for (const registration of registrations) {
    assert.equal(registration.type, "process");
    assert.equal(registration.command, "node");
    assert.equal(
      registration.args[0],
      "${ZCODE_PLUGIN_ROOT}/hooks/trellis-bridge.mjs",
    );
    assert.equal(registration.args[2], String(registration.timeoutMs));
  }
});

test("forwards payload and child output in a trusted checkout", (t) => {
  const root = createCheckout();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const payload = JSON.stringify({ cwd: root, prompt: "hello" });
  const result = runBridge(root, { payload });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, payload);
  assert.equal(result.stderr, "");
});

test("falls back after an ENOENT launcher and parses a quoted command", (t) => {
  const root = createCheckout();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const payload = JSON.stringify({ cwd: root, prompt: "fallback" });
  const result = runBridge(root, {
    payload,
    python: "trellis-python-does-not-exist",
    pythonCommand: `"${process.execPath}" --no-warnings`,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, payload);
  assert.equal(result.stderr, "");
});

test("does not execute repository code before local Trellis initialization", (t) => {
  const root = createCheckout({ trusted: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runBridge(root);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("finishes when the host leaves stdin open", async (t) => {
  const root = createCheckout();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const child = spawn(
    process.execPath,
    [bridgePath, "inject-workflow-state.py", "5000"],
    {
      cwd: root,
      env: {
        ...process.env,
        ZCODE_PROJECT_DIR: root,
        TRELLIS_PYTHON: process.execPath,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.write(JSON.stringify({ cwd: root, prompt: "open pipe" }));

  const status = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error("bridge did not exit while host stdin remained open"));
    }, 4000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve(code);
    });
  });

  assert.equal(status, 0);
  assert.equal(stdout, JSON.stringify({ cwd: root, prompt: "open pipe" }));
  assert.equal(stderr, "");
});

test("reserves one second from the host timeout", (t) => {
  const root = createCheckout({
    hookSource: "setTimeout(()=>process.stdout.write('late'),5000);",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const startedAt = Date.now();
  const result = runBridge(root, { hostTimeoutMs: "1500" });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 124);
  assert.match(result.stderr, /timed out after 1000ms/);
  assert.ok(elapsedMs < 4000, `bridge took ${elapsedMs}ms to time out`);
});
