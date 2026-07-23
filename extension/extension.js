// AEGIS VS Code extension. "Sight beyond sight."
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
let OUTPUT;
/** Run a tool as a child process with an argument ARRAY, never a shell string:
 *  a workspace path containing spaces, quotes, or $() must stay data, not code
 *  (interpolated terminal.sendText was an injection vector and broke on
 *  PowerShell 5.1, which has no `&&`). Output streams to the AEGIS channel. */
function runProcess(title, cmd, args, opts = {}) {
  const cp = require("child_process");
  OUTPUT ??= vscode.window.createOutputChannel("AEGIS");
  OUTPUT.show(true);
  OUTPUT.appendLine(`\n▶ ${title}`);
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, {
      cwd: opts.cwd ?? workspaceRoot(), env: { ...process.env, ...workspaceEnv() }, shell: false,
    });
    child.stdout?.on("data", (d) => OUTPUT.append(String(d)));
    child.stderr?.on("data", (d) => OUTPUT.append(String(d)));
    child.on("error", (e) => { OUTPUT.appendLine(`✖ ${title}: ${e.message}`); resolve(-1); });
    child.on("close", (code) => { OUTPUT.appendLine(`▶ ${title} finished (exit ${code})`); resolve(code ?? -1); });
  });
}
/** npm ships as npm.cmd on Windows, which spawn without a shell cannot start;
 *  route through cmd.exe there. Our arguments are fixed literals, so cmd's
 *  re-parsing has nothing user-controlled to misinterpret. */
function npmInvocation(args) {
  return process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "npm", ...args]]
    : ["npm", args];
}

async function install(context, withAriadne) {
  if (vscode.workspace.isTrusted === false) {
    vscode.window.showWarningMessage("AEGIS: this workspace is in Restricted Mode, trust it first (AEGIS runs indexers and git hooks).");
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
      copyIfAbsent(path.join(payload, "github-actions-aegis.yml"), path.join(root, "github-actions-aegis.yml"), log);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`AEGIS install failed: ${e.message}`);
    return;
  }
  vscode.window.showInformationMessage(`AEGIS installed ${log.length} files.`);
  if (withAriadne) {
    const pick = await vscode.window.showInformationMessage(
      "Set up Ariadne now? (installs dependencies, git hooks, and builds the initial index, runs in a terminal)",
      "Set up", "Later");
    if (pick === "Set up") {
      const rt = runtimeConfig();
      const [cmd, args] = rt === "node"
        ? ["node", [path.join(root, ".ariadne", "setup.mjs")]]
        : [process.platform === "win32" ? "python" : "python3", [path.join(root, ".ariadne", "bootstrap.py")]];
      const code = await runProcess("Ariadne setup (dependencies, hooks, initial index)", cmd, args, { cwd: root });
      if (code === 0) vscode.window.showInformationMessage("AEGIS: Ariadne is set up. Open Copilot Chat in agent mode.");
      else vscode.window.showErrorMessage("AEGIS: setup failed, see the AEGIS output channel.");
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
      // bash script (GitLab API): on Windows this needs Git Bash/WSL on PATH;
      // the spawn error handler surfaces a clear message if bash is absent
      runProcess("Pull team-shared index", "bash", [path.join(root, ".ariadne", "pull-index.sh")], { cwd: root });
    } else if (action === "approve") {
      runProcess("Approve workspace extensions", exe, [idx, "--approve-extensions"], { cwd: root });
    } else {
      runProcess(`Ariadne ${action === "status" ? "index status" : "full reindex"}`, exe,
        [idx, action === "status" ? "--status" : "--full"], { cwd: root });
    }
  };
}

/** Provide Ariadne to Copilot as an MCP server, no .vscode/mcp.json needed. */
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
    vscode.window.showWarningMessage("AEGIS: this VS Code version has no Language Model API, use enrich.mjs with a provider instead.");
    return;
  }
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (!models.length) { vscode.window.showWarningMessage("AEGIS: no Copilot chat model available (is Copilot signed in?)."); return; }
  const model = models[0];
  const os = require("os");
  const script = runtime === "node" ? "enrich.mjs" : "enrich.py";
  let plan;
  try {
    plan = JSON.parse(await runtimeExec(root, runtime, script, ["--plan"]));
  } catch (err) { vscode.window.showErrorMessage(`AEGIS enrich --plan failed: ${err.message}`); return; }
  if (!plan.length) { vscode.window.showInformationMessage("AEGIS: all insights are current (hash-cached), nothing to enrich."); return; }
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
    await runtimeExec(root, runtime, script, ["--apply", tmp]);
    vscode.window.showInformationMessage(`AEGIS: ${results.length} insights saved (Copilot). Agents can read them via the explain tool.`);
  } catch (err) { vscode.window.showErrorMessage(`AEGIS apply failed: ${err.message}`); }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

/** Interactive graph view: renders graph_export JSON in a webview (cytoscape
 *  bundled in the vsix, no CDN, zero egress) and writes annotations back through
 *  annotate.mjs/.py, the same provenance-preserving paths agents use, so a
 *  human's note or assertion is labeled as human, git-versioned, and consumable
 *  by every agent via explain/context_pack/message_flow. */
/** Async exec: the graph panel used execFileSync here, which froze the ENTIRE
 *  extension host for the duration of every export/annotate on big repos.
 *  Same contract (resolves stdout), but the editor stays responsive. */
function runtimeExec(root, runtime, script, args = []) {
  const cp = require("child_process");
  const exe = runtime === "node" ? "node" : (process.platform === "win32" ? "python" : "python3");
  return new Promise((resolve, reject) => {
    cp.execFile(exe, [path.join(root, ".ariadne", script), ...args],
      { cwd: root, env: { ...process.env, ...workspaceEnv() }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
}

function openGraphPanel(context) {
  const root = workspaceRoot();
  const runtime = root && detectRuntime(root);
  if (!runtime) { vscode.window.showWarningMessage("AEGIS: Ariadne not installed here. Run 'AEGIS: Install into Workspace' first."); return; }
  const suffix = runtime === "node" ? "mjs" : "py";
  if (!exists(path.join(root, ".ariadne", `graph_export.${suffix}`))) {
    vscode.window.showWarningMessage("AEGIS: this workspace's payload predates the graph view. Run 'AEGIS: Update Workspace Payload' first.");
    return;
  }
  const panel = vscode.window.createWebviewPanel("aegisGraph", "AEGIS Graph", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
    retainContextWhenHidden: true,
  });
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cytoUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "media", "cytoscape.min.js")));
  panel.webview.html = fs.readFileSync(path.join(context.extensionPath, "graph-view.html"), "utf8")
    .replaceAll("__NONCE__", nonce).replaceAll("__CYTOSCAPE__", String(cytoUri));

  // node positions + viewport survive closing the panel: the webview persists
  // them here (workspaceState), and every data message hands them back
  const STATE_KEY = "aegis.graphView.state";
  // skip re-export when the index hasn't moved (mtime+size of db and -wal):
  // the auto-refresh watcher can fire on reads/checkpoints; exporting an
  // unchanged graph is pure spawn cost
  let lastStat = null;
  const statKey = () => {
    try {
      const key = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
      const base = path.join(root, ".ariadne", "index.db");
      return `${key(base)}|${key(base + "-wal")}`;
    } catch { return null; }
  };
  const send = async (keepPositions, force = true) => {
    const stat = statKey();
    if (!force && stat && stat === lastStat) return;
    try {
      const graph = JSON.parse(await runtimeExec(root, runtime, `graph_export.${suffix}`));
      lastStat = stat;
      panel.webview.postMessage({ type: "data", graph, keepPositions: !!keepPositions,
        saved: context.workspaceState.get(STATE_KEY) });
    } catch (e) {
      panel.webview.postMessage({ type: "toast", message: `Graph export failed: ${String(e.stderr || e.message).trim()}`, isError: true });
    }
  };
  // live refresh: when a hook, agent, or terminal reindex touches the index,
  // the panel updates itself (debounced; positions kept; skipped if unchanged)
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, ".ariadne/index.db*"));
  let refreshT = null;
  const onIndexTouched = () => {
    clearTimeout(refreshT);
    refreshT = setTimeout(() => send(true, false), 1500);
  };
  watcher.onDidChange(onIndexTouched);
  watcher.onDidCreate(onIndexTouched);
  panel.onDidDispose(() => { clearTimeout(refreshT); watcher.dispose(); }, undefined, context.subscriptions);
  // Reindex used by the stale banner and the post-assert flow: INCREMENTAL —
  // the assertions pass runs on every incremental, so a full rebuild here was
  // pure waste — with progress, never blocking the host.
  const reindex = (title) => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => runtimeExec(root, runtime, runtime === "node" ? "indexer.mjs" : "indexer.py", ["--incremental"]));
  // multi-root workspaces index repo-prefixed paths; resolve the prefix back to a folder
  const absOf = (rel) => {
    const seg = rel.split("/")[0];
    const hit = (vscode.workspace.workspaceFolders ?? []).find((f) => path.basename(f.uri.fsPath) === seg);
    return hit ? path.join(path.dirname(hit.uri.fsPath), rel) : path.join(root, rel);
  };
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === "ready" || m.type === "refresh") {
      await send(m.type === "refresh");
    } else if (m.type === "persist") {
      context.workspaceState.update(STATE_KEY, m.state);
    } else if (m.type === "reindex") {
      try {
        await reindex("AEGIS: reindexing (incremental)…");
        panel.webview.postMessage({ type: "toast", message: "Index refreshed." });
      } catch (e) {
        panel.webview.postMessage({ type: "toast", message: String(e.stderr || e.message).trim(), isError: true });
      }
      await send(true);
    } else if (m.type === "cite") {
      // read the cited line and hand it back quoted — evidence with one click
      try {
        const lines = fs.readFileSync(absOf(m.path), "utf8").split("\n");
        const text = (lines[(m.line || 1) - 1] || "").trim().slice(0, 200);
        panel.webview.postMessage({ type: "citation", text: `${m.path}:${m.line}: ${text}` });
      } catch {
        panel.webview.postMessage({ type: "toast", message: `AEGIS: cannot read ${m.path}`, isError: true });
      }
    } else if (m.type === "openFile") {
      try {
        const doc = await vscode.workspace.openTextDocument(absOf(m.path));
        const ed = await vscode.window.showTextDocument(doc, { preview: true });
        const pos = new vscode.Position(Math.max(0, (m.line || 1) - 1), 0);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        ed.selection = new vscode.Selection(pos, pos);
      } catch { vscode.window.showWarningMessage(`AEGIS: cannot open ${m.path}`); }
    } else if (m.type === "annotate") {
      try {
        const res = await runtimeExec(root, runtime, `annotate.${suffix}`, [JSON.stringify(m.payload)]);
        panel.webview.postMessage({ type: "toast", message: res.trim() });
        if (["assert", "retract", "reaffirm"].includes(m.payload.action)) {
          // one gesture, no modal: record → incremental reindex → the graph
          // reflects the change (edge appears, disappears, or STALE clears)
          await reindex("AEGIS: updating the graph (incremental reindex)…");
        }
        await send(true);
      } catch (e) {
        panel.webview.postMessage({ type: "toast", message: String(e.stderr || e.message).trim(), isError: true });
      }
    }
  }, undefined, context.subscriptions);
}

/** Update AEGIS-managed files from the bundled payload (preserves user config, index, extensions, knowledge). */
function updateWorkspace(context) {
  const root = workspaceRoot();
  if (!root) { vscode.window.showErrorMessage("AEGIS: open a workspace first."); return; }
  const payload = path.join(context.extensionPath, "payload");
  const runtime = detectRuntime(root) ?? runtimeConfig();
  const PRESERVE = new Set(["config.json", "index.db", "index.db-wal", "index.db-shm", "index.log", ".index.lock", "extensions", "node_modules"]);
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
  // new payload versions may add dependencies, refresh them
  const arDir = path.join(root, ".ariadne");
  if (runtime === "node") {
    const [c, a] = npmInvocation(["install", "--no-audit", "--no-fund"]);
    runProcess("Refresh Ariadne dependencies", c, a, { cwd: arDir });
  } else {
    runProcess("Refresh Ariadne dependencies", process.platform === "win32" ? "python" : "python3",
      ["-m", "pip", "install", "-r", path.join(arDir, "requirements.txt")], { cwd: arDir });
  }
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
    vscode.commands.registerCommand("aegis.graph", () => openGraphPanel(context)),
    vscode.commands.registerCommand("aegis.docgen", () => {
      const root = workspaceRoot();
      const runtime = root && detectRuntime(root);
      if (!runtime) { vscode.window.showWarningMessage("AEGIS: Ariadne not installed here."); return; }
      const exe = runtime === "node" ? "node" : (process.platform === "win32" ? "python" : "python3");
      runProcess("Generate flow docs & progress report", exe,
        [path.join(root, ".ariadne", runtime === "node" ? "docgen.mjs" : "docgen.py")], { cwd: root });
    }),
    vscode.commands.registerCommand("aegis.approveExtensions", ariadneCommand("approve")),
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
