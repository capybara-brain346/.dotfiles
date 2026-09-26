import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AgentStatus = "starting" | "working" | "idle" | "exited" | "error";

type Profile = {
  description?: string;
  model?: string;
  thinkingLevel?: Thinking;
  tools?: string[];
  systemPrompt?: string;
};

type Config = {
  tmuxSessionPrefix?: string;
  windowName?: string;
  maxAgents?: number;
  defaultProfile?: string;
  defaultModel?: string;
  defaultThinkingLevel?: Thinking;
  healthPollMs?: number;
  dashboardMaxRows?: number;
  profiles?: Record<string, Profile>;
};

type Agent = {
  id: string;
  name: string;
  profile: string;
  task: string;
  cwd: string;
  target?: string;
  sessionDir: string;
  model: string;
  thinkingLevel: Thinking;
  status: AgentStatus;
  input: number;
  output: number;
  contextTokens?: number;
  contextWindow?: number;
  lastTool?: string;
  preview?: string;
  error?: string;
  createdAt: number;
};

const DEFAULT_CONFIG: Required<Pick<Config, "tmuxSessionPrefix" | "windowName" | "maxAgents" | "defaultProfile" | "defaultModel" | "defaultThinkingLevel" | "healthPollMs" | "dashboardMaxRows">> & Config = {
  tmuxSessionPrefix: "pi-subagents",
  windowName: "agents",
  maxAgents: 8,
  defaultProfile: "general",
  defaultModel: "openai-codex/gpt-5.6-luna",
  defaultThinkingLevel: "xhigh",
  healthPollMs: 2000,
  dashboardMaxRows: 5,
  profiles: {
    general: { description: "General coding helper", systemPrompt: "Work independently. Report concrete findings, changed files, and tests." },
    researcher: { description: "Read-only codebase investigator", tools: ["read", "bash", "grep", "find", "ls"], systemPrompt: "Investigate thoroughly. Do not modify files. Return evidence and recommendations." },
    reviewer: { description: "Read-only bug and security reviewer", tools: ["read", "grep", "find", "ls"], systemPrompt: "Review correctness, regressions, security, and missing tests. Do not modify files." },
    implementer: { description: "Focused implementation agent", systemPrompt: "Implement only the assigned task. Run relevant tests and report results." },
  },
};

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CONFIG_FILE = "tmux-subagents.json";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function safeName(value: string): string {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("Agent name must contain a letter or number.");
  return name.slice(0, 40);
}

async function readConfigFile(path: string): Promise<Config> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Config;
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadConfig(ctx: ExtensionContext): Promise<Config> {
  const global = await readConfigFile(join(getAgentDir(), CONFIG_FILE));
  const project = ctx.isProjectTrusted() ? await readConfigFile(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE)) : {};
  return {
    ...DEFAULT_CONFIG,
    ...global,
    ...project,
    profiles: { ...DEFAULT_CONFIG.profiles, ...global.profiles, ...project.profiles },
  };
}

function resolvedProfile(config: Config, name: string): Required<Profile> {
  const profile = config.profiles?.[name];
  if (!profile) throw new Error(`Unknown profile "${name}". Available: ${Object.keys(config.profiles ?? {}).join(", ") || "none"}.`);
  return {
    description: profile.description ?? "",
    model: profile.model ?? config.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    thinkingLevel: profile.thinkingLevel ?? config.defaultThinkingLevel ?? DEFAULT_CONFIG.defaultThinkingLevel,
    tools: profile.tools ?? DEFAULT_TOOLS,
    systemPrompt: profile.systemPrompt ?? "",
  };
}

async function findSessionFile(dir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath ?? dir, entry.name));
    if (files.length === 0) return undefined;
    return files.sort().at(-1);
  } catch {
    return undefined;
  }
}

function updateFromSession(agent: Agent, data: string): void {
  let input = 0;
  let output = 0;
  let lastAssistant: any;
  let lastRole = "";
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as any;
      if (entry.type === "message" && entry.message) {
        lastRole = entry.message.role;
        if (entry.message.role !== "assistant") continue;
        const message = entry.message;
        lastAssistant = message;
        input += message.usage?.input ?? 0;
        output += message.usage?.output ?? 0;
      }
    } catch { /* A partially-written trailing record is expected. */ }
  }
  agent.input = input;
  agent.output = output;
  if (!lastAssistant) return;
  const usage = lastAssistant.usage ?? {};
  agent.contextTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  for (const block of lastAssistant.content ?? []) {
    if (block.type === "toolCall") agent.lastTool = formatTool(block.name, block.arguments);
    if (block.type === "text" && block.text.trim()) agent.preview = short(block.text.replace(/\s+/g, " ").trim(), 160);
  }
  if (lastAssistant.stopReason === "error") {
    agent.status = "error";
    agent.error = lastAssistant.errorMessage ?? "Child Pi reported an error";
  } else if (lastRole === "user") {
    agent.status = "working";
  } else if (agent.status !== "exited") {
    agent.status = "idle";
  }
}

function formatTool(name: string, args: Record<string, unknown> | undefined): string {
  if (name === "bash") return `$ ${short(String(args?.command ?? "…"), 56)}`;
  const path = args?.path ?? args?.file_path;
  if (path) return `${name} ${short(String(path).replace(homedir(), "~"), 52)}`;
  return name;
}

export default function tmuxSubagents(pi: ExtensionAPI) {
  let agents: Agent[] = [];
  let config: Config = DEFAULT_CONFIG;
  let tmuxSession = "";
  let tmuxWindow = "";
  let tmuxAnchorWindow = "";
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;

  const persist = () => pi.appendEntry("tmux-subagents-state", { agents });
  const agentByName = (name: string) => agents.find((agent) => agent.name === safeName(name));

  async function tmux(args: string[], ctx?: ExtensionContext): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await pi.exec("tmux", args, { timeout: 10_000, signal: ctx?.signal });
    return result;
  }

  async function paneExists(agent: Agent): Promise<boolean> {
    if (!agent.target) return false;
    const result = await tmux(["display-message", "-p", "-t", agent.target, "#{pane_dead}"]);
    return result.code === 0 && result.stdout.trim() === "0";
  }

  async function refreshAgent(agent: Agent): Promise<void> {
    if (agent.status !== "error") {
      const alive = await paneExists(agent);
      if (!alive) agent.status = "exited";
    }
    const file = await findSessionFile(agent.sessionDir);
    if (file) {
      try { updateFromSession(agent, await readFile(file, "utf8")); } catch { /* child can rotate/write during read */ }
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all(agents.map(refreshAgent));
    render?.();
  }

  async function ensureTmuxWindow(ctx: ExtensionContext, cwd: string, command: string): Promise<string> {
    const windowTarget = `${tmuxSession}:${tmuxWindow}`;
    const hasSession = await tmux(["has-session", "-t", tmuxSession]);
    if (hasSession.code !== 0) {
      const created = await tmux(["new-session", "-d", "-s", tmuxSession, "-n", tmuxWindow, "-c", cwd, command], ctx);
      if (created.code !== 0) throw new Error(created.stderr || "Unable to create tmux session.");
      return `${tmuxSession}:${tmuxWindow}.0`;
    }
    const hasWindow = await tmux(["has-window", "-t", windowTarget]);
    if (hasWindow.code !== 0) {
      const created = await tmux(["new-window", "-d", "-a", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-t", tmuxAnchorWindow || tmuxSession, "-n", tmuxWindow, "-c", cwd, command], ctx);
      if (created.code !== 0) throw new Error(created.stderr || "Unable to create tmux window.");
      return created.stdout.trim();
    }
    const split = await tmux(["split-window", "-d", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-t", windowTarget, "-c", cwd, command], ctx);
    if (split.code !== 0) throw new Error(split.stderr || "Unable to create tmux pane.");
    await tmux(["select-layout", "-t", windowTarget, "tiled"]);
    return split.stdout.trim();
  }

  async function spawn(nameInput: string, profileName: string, task: string, cwd: string | undefined, ctx: ExtensionContext): Promise<Agent> {
    const name = safeName(nameInput);
    if (agentByName(name)) throw new Error(`An agent named "${name}" already exists.`);
    if (agents.filter((agent) => agent.status !== "exited").length >= (config.maxAgents ?? 8)) throw new Error(`Maximum of ${config.maxAgents ?? 8} agents reached.`);
    if (!task.trim()) throw new Error("A task is required.");
    const profile = resolvedProfile(config, profileName);
    const agentCwd = resolve(ctx.cwd, cwd ?? ".");
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionDir = join(getAgentDir(), "tmux-subagent-sessions", tmuxSession, id);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const prompt = `You are sub-agent ${name}.\n\n${profile.systemPrompt}\n\nAssigned task:\n${task}`;
    const argv = ["pi", "--session-dir", sessionDir, "--name", `subagent:${name}:${id}`, "--model", profile.model, "--thinking", profile.thinkingLevel, "--tools", profile.tools.join(","), "--append-system-prompt", prompt, task];
    const command = `exec ${argv.map(shellQuote).join(" ")}`;
    const agent: Agent = { id, name, profile: profileName, task, cwd: agentCwd, sessionDir, model: profile.model, thinkingLevel: profile.thinkingLevel, status: "starting", input: 0, output: 0, createdAt: Date.now() };
    agents.push(agent);
    try {
      agent.target = await ensureTmuxWindow(ctx, agentCwd, command);
      agent.status = "working";
      persist();
      await refreshAll();
      return agent;
    } catch (error) {
      agents = agents.filter((item) => item.id !== id);
      throw error;
    }
  }

  function updateDashboard(ctx: ExtensionContext): void {
    if (agents.length === 0) {
      ctx.ui.setWidget("tmux-subagents", undefined);
      ctx.ui.setStatus("tmux-subagents", undefined);
      return;
    }
    const running = agents.filter((agent) => agent.status === "working" || agent.status === "starting").length;
    ctx.ui.setStatus("tmux-subagents", ctx.ui.theme.fg(running ? "accent" : "muted", `agents:${running} active`));
    ctx.ui.setWidget("tmux-subagents", (tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        render = () => tui.requestRender();
        const visible = agents.slice(0, config.dashboardMaxRows ?? 5);
        const header = theme.fg("accent", theme.bold(" SUB-AGENTS")) + theme.fg("dim", `  ${running} active  /agents to manage`);
        const rows = visible.map((agent) => {
          const icon = agent.status === "error" || agent.status === "exited" ? theme.fg("error", "●") : agent.status === "idle" ? theme.fg("muted", "○") : theme.fg("success", "●");
          const state = agent.status === "working" || agent.status === "starting" ? theme.fg("accent", agent.status) : agent.status === "idle" ? theme.fg("muted", "idle") : theme.fg("error", agent.status);
          const context = agent.contextTokens && agent.contextWindow ? ` ctx ${Math.round((agent.contextTokens / agent.contextWindow) * 100)}%` : agent.contextTokens ? ` ctx ${formatTokens(agent.contextTokens)}` : "";
          const metadata = ` ${agent.model.split("/").at(-1)}/${agent.thinkingLevel}${context} ↑${formatTokens(agent.input)} ↓${formatTokens(agent.output)}`;
          const last = agent.error ?? agent.lastTool ?? agent.preview ?? agent.task;
          const row = `${icon} ${theme.bold(agent.name)} ${state}${theme.fg("dim", metadata)}  ${theme.fg("muted", short(last, 58))}`;
          return truncateToWidth(row, width);
        });
        if (agents.length > visible.length) rows.push(theme.fg("dim", ` … +${agents.length - visible.length} more`));
        return [truncateToWidth(header, width), ...rows];
      },
    }));
  }

  async function focus(agent: Agent, ctx: ExtensionContext): Promise<void> {
    if (!agent.target || !(await paneExists(agent))) throw new Error(`Pane for "${agent.name}" is no longer available.`);
    const result = await tmux(["select-window", "-t", agent.target], ctx);
    if (result.code !== 0) throw new Error(result.stderr || "Could not focus tmux pane.");
    await tmux(["select-pane", "-t", agent.target], ctx);
  }

  async function send(agent: Agent, message: string, ctx: ExtensionContext): Promise<void> {
    if (!message.trim()) throw new Error("Message is empty.");
    if (!agent.target || !(await paneExists(agent))) throw new Error(`Pane for "${agent.name}" is no longer available.`);
    const result = await tmux(["send-keys", "-t", agent.target, "-l", message], ctx);
    if (result.code !== 0) throw new Error(result.stderr || "Could not send message.");
    await tmux(["send-keys", "-t", agent.target, "Enter"], ctx);
    agent.status = "working";
    persist();
  }

  async function stop(agent: Agent, ctx: ExtensionContext): Promise<void> {
    if (!agent.target || !(await paneExists(agent))) throw new Error(`Pane for "${agent.name}" is no longer available.`);
    const result = await tmux(["send-keys", "-t", agent.target, "Escape"], ctx);
    if (result.code !== 0) throw new Error(result.stderr || "Could not interrupt tmux pane.");
    agent.status = "idle";
    persist();
  }

  async function close(agent: Agent, ctx: ExtensionContext): Promise<void> {
    if (agent.target && (await paneExists(agent))) await tmux(["kill-pane", "-t", agent.target], ctx);
    agents = agents.filter((item) => item.id !== agent.id);
    persist();
    updateDashboard(ctx);
  }

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: "Start an interactive Pi sub-agent in a tmux pane. Use it for bounded, independent work. The user can directly interact with the pane. Use inspect_subagent to read progress.",
    promptSnippet: "Spawn interactive tmux sub-agents for independent tasks",
    promptGuidelines: ["Use spawn_subagent only for a clear independent task; specify a profile and expected deliverable."],
    parameters: Type.Object({
      name: Type.String({ description: "Unique short agent name" }),
      profile: Type.Optional(Type.String({ description: "Configured profile; defaults to general" })),
      task: Type.String({ description: "Bounded task and expected deliverable" }),
      cwd: Type.Optional(Type.String({ description: "Working directory, relative to the master cwd" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const agent = await spawn(params.name, params.profile ?? config.defaultProfile ?? "general", params.task, params.cwd, ctx);
      return { content: [{ type: "text", text: `Started ${agent.name} (${agent.profile}) in tmux pane ${agent.target}. It is directly interactive; inspect it with inspect_subagent.` }], details: { agent } };
    },
  });

  pi.registerTool({
    name: "inspect_subagent",
    label: "Inspect Subagent",
    description: "Read bounded status and last known output from an interactive tmux sub-agent.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const agent = agentByName(params.name);
      if (!agent) throw new Error(`Unknown agent "${params.name}".`);
      await refreshAgent(agent);
      updateDashboard(ctx);
      return { content: [{ type: "text", text: `${agent.name}: ${agent.status}; ${agent.lastTool ?? agent.preview ?? "no output yet"}` }], details: { agent } };
    },
  });

  pi.registerCommand("agents", {
    description: "Manage tmux-backed sub-agents: profiles, panes, and status",
    getArgumentCompletions: (prefix) => ["new", "profiles", "profile", "focus", "send", "stop", "close", "refresh"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!action) {
        await refreshAll();
        const choices = [
          ...agents.map((agent) => `${agent.name} — ${agent.status} — ${agent.profile}`),
          "New agent…",
          "Profiles…",
        ];
        const selected = await ctx.ui.select("Sub-agents", choices);
        if (!selected) return;
        if (selected === "New agent…") { await createInteractive(ctx); return; }
        if (selected === "Profiles…") { await manageProfiles(ctx); return; }
        const agent = agentByName(selected.split(" — ")[0]!);
        if (agent) await agentMenu(agent, ctx);
        return;
      }
      if (action === "new") { await createInteractive(ctx, rest[0], rest.slice(1).join(" ")); return; }
      if (action === "profiles" || action === "profile") { await manageProfiles(ctx); return; }
      if (action === "refresh") { await refreshAll(); updateDashboard(ctx); return; }
      const agent = agentByName(rest[0] ?? "");
      if (!agent) throw new Error(`Unknown agent "${rest[0] ?? ""}".`);
      if (action === "focus") { await focus(agent, ctx); return; }
      if (action === "send") { await send(agent, rest.slice(1).join(" "), ctx); updateDashboard(ctx); return; }
      if (action === "stop") { await stop(agent, ctx); updateDashboard(ctx); return; }
      if (action === "close") { if (await ctx.ui.confirm("Close sub-agent?", `Kill tmux pane for ${agent.name}?`)) await close(agent, ctx); return; }
      throw new Error(`Unknown /agents action "${action}".`);
    },
  });

  async function createInteractive(ctx: ExtensionContext, profileHint?: string, taskHint?: string): Promise<void> {
    const profileNames = Object.keys(config.profiles ?? {});
    const profile = profileHint && config.profiles?.[profileHint] ? profileHint : await ctx.ui.select("Sub-agent profile", profileNames);
    if (!profile) return;
    const name = await ctx.ui.input("Agent name", profile);
    if (!name?.trim()) return;
    const task = taskHint || await ctx.ui.editor("Assigned task", "");
    if (!task?.trim()) return;
    const agent = await spawn(name, profile, task, undefined, ctx);
    updateDashboard(ctx);
    ctx.ui.notify(`Started ${agent.name} in ${agent.target}`, "info");
  }

  async function agentMenu(agent: Agent, ctx: ExtensionContext): Promise<void> {
    const choice = await ctx.ui.select(`${agent.name} (${agent.status})`, ["Focus tmux pane", "Send message", "Stop (Escape)", "Close pane"]);
    if (choice === "Focus tmux pane") await focus(agent, ctx);
    if (choice === "Send message") { const message = await ctx.ui.editor(`Message to ${agent.name}`, ""); if (message) await send(agent, message, ctx); }
    if (choice === "Stop (Escape)") await stop(agent, ctx);
    if (choice === "Close pane" && await ctx.ui.confirm("Close sub-agent?", `Kill ${agent.name}?`)) await close(agent, ctx);
    updateDashboard(ctx);
  }

  async function saveGlobalConfig(): Promise<void> {
    const path = join(getAgentDir(), CONFIG_FILE);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }

  async function manageProfiles(ctx: ExtensionContext): Promise<void> {
    const names = Object.keys(config.profiles ?? {});
    const choice = await ctx.ui.select("Sub-agent profiles", [...names, "Add profile…", "Remove profile…"]);
    if (!choice) return;
    if (choice === "Add profile…") {
      const name = await ctx.ui.input("Profile name", "");
      if (!name?.trim()) return;
      const key = safeName(name);
      if (config.profiles?.[key]) throw new Error(`Profile "${key}" already exists.`);
      const source = await ctx.ui.select("Base profile", names);
      if (!source) return;
      config.profiles = { ...config.profiles, [key]: { ...config.profiles?.[source], description: `Custom ${key} profile` } };
      await saveGlobalConfig();
      ctx.ui.notify(`Added profile ${key}`, "info");
      return;
    }
    if (choice === "Remove profile…") {
      const target = await ctx.ui.select("Remove profile", names);
      if (!target || target === config.defaultProfile) { if (target) ctx.ui.notify("Choose another default profile before removing it.", "warning"); return; }
      if (await ctx.ui.confirm("Remove profile?", `Remove ${target} from global configuration? Existing agents are unaffected.`)) {
        const { [target]: _removed, ...profiles } = config.profiles ?? {};
        config.profiles = profiles;
        await saveGlobalConfig();
      }
      return;
    }
    const profile = config.profiles?.[choice];
    if (!profile) return;
    const edited = await ctx.ui.editor(`Edit profile ${choice} as JSON`, JSON.stringify(profile, null, 2));
    if (!edited) return;
    try {
      const parsed = JSON.parse(edited) as Profile;
      config.profiles = { ...config.profiles, [choice]: parsed };
      await saveGlobalConfig();
      ctx.ui.notify(`Saved profile ${choice}`, "info");
    } catch (error) { ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  }

  pi.registerShortcut(Key.ctrlAlt("a"), { description: "Open sub-agent manager", handler: async (ctx) => pi.sendUserMessage("/agents", { expandPromptTemplates: true }) });

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx);
    const latest = ctx.sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "tmux-subagents-state").at(-1) as any;
    agents = Array.isArray(latest?.data?.agents) ? latest.data.agents : [];
    const sessionId = ctx.sessionManager.getSessionId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
    tmuxWindow = `${config.windowName ?? "agents"}-${sessionId}`;
    // When Pi already runs in tmux, create a visible sibling window in that session.
    // Outside tmux, create a dedicated detached session that can be attached manually.
    if (process.env.TMUX) {
      const current = await tmux(["display-message", "-p", "#{session_name}:#{window_index}"]);
      tmuxAnchorWindow = current.code === 0 ? current.stdout.trim() : "";
      tmuxSession = tmuxAnchorWindow
        ? tmuxAnchorWindow.split(":", 1)[0]!
        : `${config.tmuxSessionPrefix}-${sessionId}`;
    } else {
      tmuxSession = `${config.tmuxSessionPrefix}-${sessionId}`;
      tmuxAnchorWindow = "";
    }
    for (const agent of agents) agent.contextWindow ??= undefined;
    await refreshAll();
    updateDashboard(ctx);
    healthTimer = setInterval(() => { void refreshAll().then(() => updateDashboard(ctx)); }, config.healthPollMs ?? 2000);
  });

  pi.on("session_shutdown", async () => {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = undefined;
    persist();
  });
}
