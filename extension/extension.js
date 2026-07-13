// AEGIS VS Code extension — "Sight beyond sight."
// Installs the AEGIS payload into the workspace, registers the Ariadne MCP
// server with Copilot, and provides index maintenance commands.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}
/** All workspace folders; when >1, Ariadne runs in multi-root mode via ARIADNE_ROOTS. */
function workspaceEnv() {
  const ws = vscode.workspace.workspaceFolders ?? [];
  if (ws.length <= 1) return {};
  return { ARIADNE_ROOTS: ws.map((f) => f.uri.fsPath).join(","), ARIADNE_HOME: ws[0].uri.fsPath };
}
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/** Recursive copy that never overwrites existing files (idempotent installs). */
function copyIfAbsent(src, dst, log) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!exists(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyIfAbsent(path.join(src, entry), path.join(dst, entry), log);
    }
  } else if (!exists(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    log.push(dst);
  }
}

function appendInstructions(root, payload, log) {
  const snippet = path.join(payload, "copilot-instructions-snippet.md");
  const target = path.join(root, ".github", "copilot-instructions.md");
  if (!exists(snippet)) return;
  const body = fs.readFileSync(snippet, "utf8").replace(/^(#[^\n]*\n)+\n?/, "");
  if (exists(target) && fs.readFileSync(target, "utf8").includes("Codebase knowledge base")) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, "\n" + body);
  log.push(target + " (appended)");
}

function runtimeConfig() {
  return vscode.workspace.getConfiguration("aegis").get("runtime", "node");
}
function indexerPath(root, runtime) {
  return path.join(root, ".ariadne", runtime === "node" ? "indexer.mjs" : "indexer.py");
}
function detectRuntime(root) {
  if (exists(path.join(root, ".ariadne", "indexer.mjs"))) return "node";
  if (exists(path.join(root, ".ariadne", "indexer.py"))) return "python";
  return null;
}
function runInTerminal(name, cmd) {
  // env passed via terminal options: works identically in PowerShell, cmd, bash, zsh
  const t = vscode.window.createTerminal({ name, env: workspaceEnv() });
  t.show(true);
  t.sendText(cmd);
}

async function install(context, withAriadne) {
  if (vscode.workspace.isTrusted === false) {
    vscode.window.showWarningMessage("AEGIS: this workspace is in Restricted Mode — trust it first (AEGIS runs indexers and git hooks).");
    return;
  }
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage("AEGIS: open a folder/workspace first."); return; }
  const payload = path.join(context.extensionPath, "payload");
  const runtime = runtimeConfig();
  const log = [];
  try {
    copyIfAbsent(path.join(payload, ".github"), path.join(root, ".github"), log);
    copyIfAbsent(path.join(payload, "constitution-template.md"),
      path.join(root, "docs", "constitution.md"), log);
    appendInstructions(root, payload, log);
    if (withAriadne) {
      copyIfAbsent(path.join(payload, `ariadne-${runtime}`), path.join(root, ".ariadne"), log);
      copyIfAbsent(path.join(payload, "install-hooks.sh"), path.join(root, ".ariadne", "install-hooks.sh"), log);
      copyIfAbsent(path.join(payload, "pull-index.sh"), path.join(root, ".ariadne", "pull-index.sh"), log);
      copyIfAbsent(path.join(payload, "gitlab-ci-aegis.yml"), path.join(root, "gitlab-ci-aegis.yml"), log);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`AEGIS install failed: ${e.message}`);
    return;
  }
  vscode.window.showInformationMessage(`AEGIS installed ${log.length} files.`);
  if (withAriadne) {
    const pick = await vscode.window.showInformationMessage(
      "Set up Ariadne now? (installs dependencies, git hooks, and builds the initial index — runs in a terminal)",
      "Set up", "Later");
    if (pick === "Set up") {
      const rt = runtimeConfig();
      const setup = rt === "node"
        ? `node "${path.join(root, ".ariadne", "setup.mjs")}"`
        : `${process.platform === "win32" ? "python" : "python3"} "${path.join(root, ".ariadne", "setup.py")}"`;
      runInTerminal("AEGIS setup", setup);
    }
  }
}

function ariadneCommand(action) {
  return () => {
    const root = workspaceRoot();
    const runtime = root && detectRuntime(root);
    if (!runtime) {
      vscode.window.showWarningMessage("AEGIS: Ariadne not installed here. Run 'AEGIS: Install into Workspace' first.");
      return;
    }
    const idx = indexerPath(root, runtime);
    const exe = runtime === "node" ? "node" : (process.platform === "win32" ? "python" : "python3");
    if (action === "pull") {
      runInTerminal("AEGIS pull index", `bash "${path.join(root, ".ariadne", "pull-index.sh")}"`);
    } else {
      runInTerminal(`AEGIS ${action}`, `${exe} "${idx}" --${action === "status" ? "status" : "full"}`);
    }
  };
}

/** Provide Ariadne to Copilot as an MCP server — no .vscode/mcp.json needed. */
function readAegisConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "aegis.json"), "utf8")); }
  catch { return null; }
}

function registerMcpProvider(context) {
  // Workspace Trust: never auto-run a workspace's server code in Restricted Mode
  if (vscode.workspace.isTrusted === false) {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => registerMcpProvider(context)));
    return;
  }
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== "function") {
    // Older VS Code: fall back silently; .vscode/mcp.json from install.sh still works.
    return;
  }
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeMcpServerDefinitions: emitter.event,
    provideMcpServerDefinitions() {
      const root = workspaceRoot();
      const auto = vscode.workspace.getConfiguration("aegis").get("autoRegisterAriadne", true);
      if (!root || !auto) return [];
      const cfg = readAegisConfig(root);
      if (cfg && cfg.graphEngine && cfg.graphEngine !== "ariadne") {
        const m = cfg.mcp || {};
        if (!m.command || m.command === "REPLACE_ME") return [];
        return [new vscode.McpStdioServerDefinition(cfg.graphEngine, m.command, m.args || [], {}, "1.0.0")];
      }
      const runtime = detectRuntime(root);
      if (!runtime) return [];
      const exe = runtime === "node" ? "node" : (process.platform === "win32" ? "python" : "python3");
      const serverFile = path.join(root, ".ariadne", runtime === "node" ? "server.mjs" : "server.py");
      return [new vscode.McpStdioServerDefinition("ariadne", exe, [serverFile], workspaceEnv(), "2.0.0")];
    },
  };
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("aegis.ariadne", provider));
  // refresh when .ariadne appears/disappears
  const watcher = vscode.workspace.createFileSystemWatcher("{**/.ariadne/server.*,**/aegis.json}");
  watcher.onDidCreate(() => emitter.fire());
  watcher.onDidDelete(() => emitter.fire());
  context.subscriptions.push(watcher);
}

/** Enrich insights using the user's Copilot subscription via the VS Code LM API. */
async function enrichViaCopilot(context) {
  const root = workspaceRoot();
  const runtime = root && detectRuntime(root);
  if (!runtime) { vscode.window.showWarningMessage("AEGIS: Ariadne not installed here."); return; }
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
    vscode.window.showWarningMessage("AEGIS: this VS Code version has no Language Model API — use enrich.mjs with a provider instead.");
    return;
  }
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (!models.length) { vscode.window.showWarningMessage("AEGIS: no Copilot chat model available (is Copilot signed in?)."); return; }
  const model = models[0];
  const cp = require("child_process");
  const os = require("os");
  const exe = runtime === "node" ? "node" : (process.platform === "win32" ? "python" : "python3");
  const script = path.join(root, ".ariadne", runtime === "node" ? "enrich.mjs" : "enrich.py");
  let plan;
  try {
    plan = JSON.parse(cp.execFileSync(exe, [script, "--plan"], { cwd: root, env: { ...process.env, ...workspaceEnv() }, encoding: "utf8" }));
  } catch (err) { vscode.window.showErrorMessage(`AEGIS enrich --plan failed: ${err.message}`); return; }
  if (!plan.length) { vscode.window.showInformationMessage("AEGIS: all insights are current (hash-cached) — nothing to enrich."); return; }
  const results = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `AEGIS: enriching ${plan.length} targets via Copilot (${model.name})`, cancellable: true },
    async (progress, token) => {
      for (const t of plan) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${t.kind}: ${t.target}`, increment: 100 / plan.length });
        try {
          const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(t.prompt)], {}, token);
          let text = "";
          for await (const chunk of res.text) text += chunk;
          results.push({ target: t.target, kind: t.kind, hash: t.hash, summary: text.trim(), model: `copilot:${model.name}` });
        } catch (err) { console.error(`AEGIS enrich ${t.target}: ${err.message}`); }
      }
    });
  if (!results.length) { vscode.window.showWarningMessage("AEGIS: no insights generated."); return; }
  const tmp = path.join(os.tmpdir(), `aegis-insights-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(results));
  try {
    cp.execFileSync(exe, [script, "--apply", tmp], { cwd: root, env: { ...process.env, ...workspaceEnv() } });
    vscode.window.showInformationMessage(`AEGIS: ${results.length} insights saved (Copilot). Agents can read them via the explain tool.`);
  } catch (err) { vscode.window.showErrorMessage(`AEGIS apply failed: ${err.message}`); }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

/** Update AEGIS-managed files from the bundled payload (preserves user config, index, extensions, knowledge). */
function updateWorkspace(context) {
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage("AEGIS: open a workspace first."); return; }
  const payload = path.join(context.extensionPath, "payload");
  const runtime = detectRuntime(root) ?? runtimeConfig();
  const PRESERVE = new Set(["config.json", "index.db", "index.db-wal", "index.db-shm", "index.log", "index.lock", "extensions", "node_modules"]);
  let updated = 0;
  const overwriteDir = (src, dst) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (PRESERVE.has(entry.name)) continue;
      const s = path.join(src, entry.name), d = path.join(dst, entry.name);
      if (entry.isDirectory()) overwriteDir(s, d);
      else { fs.copyFileSync(s, d); updated++; }
    }
  };
  overwriteDir(path.join(payload, `ariadne-${runtime}`), path.join(root, ".ariadne"));
  overwriteDir(path.join(payload, ".github", "skills"), path.join(root, ".github", "skills"));
  overwriteDir(path.join(payload, ".github", "agents"), path.join(root, ".github", "agents"));
  // new payload versions may add dependencies — refresh them
  const dep = runtime === "node"
    ? `cd "${path.join(root, ".ariadne")}" && npm install --no-audit --no-fund`
    : `${process.platform === "win32" ? "python" : "python3"} -m pip install -r "${path.join(root, ".ariadne", "requirements.txt")}"`;
  runInTerminal("AEGIS update deps", dep);
  vscode.window.showInformationMessage(`AEGIS updated ${updated} managed files (config, index, knowledge, and extensions preserved). Rebuild the index if the schema changed: AEGIS: Rebuild Index.`);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("aegis.install", () => install(context, true)),
    vscode.commands.registerCommand("aegis.installLite", () => install(context, false)),
    vscode.commands.registerCommand("aegis.reindex", ariadneCommand("full")),
    vscode.commands.registerCommand("aegis.status", ariadneCommand("status")),
    vscode.commands.registerCommand("aegis.pullIndex", ariadneCommand("pull")),
    vscode.commands.registerCommand("aegis.enrichCopilot", () => enrichViaCopilot(context)),
    vscode.commands.registerCommand("aegis.update", () => updateWorkspace(context)),
    vscode.commands.registerCommand("aegis.docgen", () => {
      const root = workspaceRoot();
      const runtime = root && detectRuntime(root);
      if (!runtime) { vscode.window.showWarningMessage("AEGIS: Ariadne not installed here."); return; }
      const exe = runtime === "node" ? "node .ariadne/docgen.mjs" : `${process.platform === "win32" ? "python" : "python3"} .ariadne/docgen.py`;
      runInTerminal("AEGIS docgen", exe);
    }),
  );
  registerMcpProvider(context);

  // Gentle one-time nudge when a workspace has no AEGIS yet
  const root = workspaceRoot();
  if (root && !exists(path.join(root, ".github", "skills")) &&
      !context.globalState.get("aegis.nudged." + root)) {
    context.globalState.update("aegis.nudged." + root, true);
    vscode.window.showInformationMessage(
      "AEGIS: this workspace isn't set up yet. Install skills, agents, and Ariadne?",
      "Install", "Not now"
    ).then((pick) => { if (pick === "Install") install(context, true); });
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
