import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_REFRESH_MS = 15_000;
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

type UsageWindow = {
  used_percent: number;
};

type CodexUsage = {
  primary?: UsageWindow;
  secondary?: UsageWindow;
};

const formatCount = (value: number): string => {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
};

const accountIdFromToken = (token: string): string | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded[ACCOUNT_CLAIM]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
};

const usageGraph = (percentLeft: number): string => {
  const cells = 8;
  const filled = Math.round((Math.max(0, Math.min(100, percentLeft)) / 100) * cells);
  return `${"▰".repeat(filled)}${"▱".repeat(cells - filled)}`;
};

const usageLeft = (usedPercent: number): number => Math.max(0, Math.min(100, 100 - usedPercent));

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    let usage: CodexUsage | undefined;
    let request: AbortController | undefined;

    const updateUsage = async () => {
      request?.abort();
      request = new AbortController();

      try {
        const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
        const token = auth?.auth.apiKey;
        const accountId = token ? accountIdFromToken(token) : undefined;
        if (!token || !accountId) return;

        const response = await fetch(USAGE_ENDPOINT, {
          headers: {
            Authorization: `Bearer ${token}`,
            "chatgpt-account-id": accountId,
            originator: "pi",
          },
          signal: request.signal,
        });
        if (!response.ok) return;

        const payload = (await response.json()) as { rate_limit?: { primary_window?: UsageWindow; secondary_window?: UsageWindow } };
        usage = {
          primary: payload.rate_limit?.primary_window,
          secondary: payload.rate_limit?.secondary_window,
        };
        ctx.ui.setFooter(footer);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) return;
      }
    };

    const footer = (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const message = entry.message as AssistantMessage;
              input += message.usage.input;
              output += message.usage.output;
            }
          }

          const directory = basename(ctx.cwd) || ctx.cwd;
          const branch = footerData.getGitBranch() ?? "no git";
          const contextUsage = ctx.getContextUsage();
          const contextWindow = ctx.model?.contextWindow;
          const context =
            contextUsage && contextWindow
              ? `${formatCount(contextUsage.tokens)}/${formatCount(contextWindow)} (${Math.round((contextUsage.tokens / contextWindow) * 100)}%)`
              : "--/-- (--%)";

          const required = [
            theme.fg("accent", theme.bold("DIR ")) + theme.bold(directory),
            theme.fg("success", theme.bold("GIT ")) + theme.bold(branch),
          ];
          const optional = [
            usage?.primary && (() => {
              const left = usageLeft(usage.primary.used_percent);
              return theme.fg("warning", `5h ${usageGraph(left)} ${Math.round(left)}%`);
            })(),
            usage?.secondary && (() => {
              const left = usageLeft(usage.secondary.used_percent);
              return theme.fg("warning", `week ${usageGraph(left)} ${Math.round(left)}%`);
            })(),
            theme.fg("warning", theme.bold("CTX ")) + theme.bold(context),
            theme.fg("muted", "IN ") + theme.bold(formatCount(input)),
            theme.fg("muted", "OUT ") + theme.bold(formatCount(output)),
          ].filter((segment): segment is string => Boolean(segment));
          const right = theme.fg("accent", ctx.model?.name ?? ctx.model?.id ?? "no model") +
            theme.fg("muted", ` · ${ctx.thinkingLevel}`);

          const segments = [...required];
          for (const segment of optional) {
            if (visibleWidth([...segments, segment].join("  ")) + visibleWidth(right) + 1 > width) break;
            segments.push(segment);
          }

          const left = truncateToWidth(
            segments.join("  "),
            Math.max(0, width - visibleWidth(right) - 1),
            "",
          );
          const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          return [truncateToWidth(left + padding + right, width)];
        },
      };
    };

    const interval = setInterval(() => void updateUsage(), USAGE_REFRESH_MS);
    void updateUsage();
    pi.on("turn_end", () => void updateUsage());
    pi.on("session_shutdown", () => {
      clearInterval(interval);
      request?.abort();
    });

    ctx.ui.setFooter(footer);
  });
}
