import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "web_search"]);
const STATE_ENTRY = "plan-mode-state";
const PLAN_MODE_PROMPT = `
Plan mode is active. Investigate with the available read-only tools. Do not make changes or claim that changes were made. Return an implementation plan with affected files, changes, and verification.

Always use ASCII diagrams for data flow and sequence diagrams for communication between two entities.
When proposing changes to functions or classes, include a call-stack diff showing the relevant caller → changed method/function → callee paths before and after, marking added, removed, or rerouted calls. Trace actual callers and callees in the code; omit unrelated frames.
`;

type PlanModeState = {
  enabled: boolean;
  toolsBeforePlanMode?: string[];
};

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let toolsBeforePlanMode: string[] | undefined;

  const persist = () => {
    pi.appendEntry(STATE_ENTRY, { enabled, toolsBeforePlanMode } satisfies PlanModeState);
  };

  const setIndicator = (ctx: ExtensionContext) => {
    if (!enabled) {
      ctx.ui.setStatus("plan-mode", undefined);
      ctx.ui.setWidget("plan-mode", undefined);
      return;
    }

    ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "[ PLAN MODE ]"));
    ctx.ui.setWidget("plan-mode", [ctx.ui.theme.fg("warning", "[ PLAN MODE ]")]);
  };

  const enter = (ctx: ExtensionContext) => {
    if (enabled) return;

    toolsBeforePlanMode = pi.getActiveTools();
    enabled = true;
    pi.setActiveTools(toolsBeforePlanMode.filter((name) => READ_ONLY_TOOLS.has(name)));
    setIndicator(ctx);
    persist();
    pi.events.emit("plan-mode:change", { enabled: true });
    ctx.ui.notify("Plan mode enabled. Only read, grep, find, ls, and web_search are available.", "info");
  };

  const exit = (ctx: ExtensionContext) => {
    if (!enabled) return;

    enabled = false;
    pi.setActiveTools(toolsBeforePlanMode ?? pi.getActiveTools());
    toolsBeforePlanMode = undefined;
    setIndicator(ctx);
    persist();
    pi.events.emit("plan-mode:change", { enabled: false });
    ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
  };

  pi.registerFlag("plan", {
    description: "Start in read-only plan mode",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("plan", {
    description: "Toggle read-only plan mode",
    handler: async (_args, ctx) => enabled ? exit(ctx) : enter(ctx),
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle read-only plan mode",
    handler: async (ctx) => enabled ? exit(ctx) : enter(ctx),
  });

  // Active tools are a prompt-level control. Block stale or in-flight calls too.
  pi.on("tool_call", (event) => {
    if (enabled && !READ_ONLY_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode permits only read-only tools: ${[...READ_ONLY_TOOLS].join(", ")}. Disable it with /plan to make changes.`,
      };
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n${PLAN_MODE_PROMPT}` };
  });

  pi.on("session_start", (_event, ctx) => {
    const prior = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry): entry is typeof entry & { type: "custom"; customType: string; data?: PlanModeState } =>
        entry.type === "custom" && entry.customType === STATE_ENTRY,
      );

    enabled = pi.getFlag("plan") === true || prior?.data?.enabled === true;
    toolsBeforePlanMode = prior?.data?.toolsBeforePlanMode;

    if (enabled) {
      toolsBeforePlanMode ??= pi.getActiveTools();
      pi.setActiveTools(toolsBeforePlanMode.filter((name) => READ_ONLY_TOOLS.has(name)));
    }
    setIndicator(ctx);
    pi.events.emit("plan-mode:change", { enabled });
  });
}
