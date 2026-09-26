import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

type Letter = {
  color: "text" | "accent" | "muted";
  rows: readonly string[];
};

// Six rows leave room for the descender in “y”. Each letter owns its spacing.
const WORDMARK: readonly Letter[] = [
  { color: "text", rows: ["██  ██", "██  ██", "██████", "██  ██", "██  ██", ""] },
  { color: "text", rows: ["██", "", "██", "██", "██", ""] },
  { color: "text", rows: ["██", "██", "██", "", "██", ""] },
  { color: "text", rows: ["  ", "", "", "", "", ""] },
  { color: "accent", rows: ["▄▄▄▄▄▄▄▄▄▄", "▀██▀▀▀██▀▀", " ██   ██", " ██   ██", "▄██   ▀██▄", ""] },
  { color: "muted", rows: [" ▄█", "██", "██", "██", " ▀█", ""] },
  { color: "text", rows: ["", "", "██  ██", "██  ██", " ▀▀███", " ▀███▀"] },
  { color: "text", rows: ["", "", "██  ██", "██  ██", " ▀██▀█", ""] },
  { color: "text", rows: ["", "", " ▄███▀", " ▀███▄", "▄███▀", ""] },
  { color: "text", rows: ["██", "██", "██▀██▄", "██  ██", "██  ██", ""] },
  { color: "muted", rows: ["█▄", " ██", " ██", " ██", "█▀", ""] },
];

const LETTER_WIDTHS = WORDMARK.map(({ rows }) => Math.max(...rows.map(visibleWidth)));
const WORDMARK_WIDTH = LETTER_WIDTHS.reduce((sum, width) => sum + width, 0) + WORDMARK.length - 1;

function wordmark(theme: Theme): string[] {
  return Array.from({ length: 6 }, (_, row) =>
    WORDMARK.map((letter, index) => {
      const text = letter.rows[row] ?? "";
      const padded = text + " ".repeat(LETTER_WIDTHS[index]! - visibleWidth(text));
      return theme.fg(letter.color, padded);
    }).join(" "),
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const project = basename(ctx.cwd) || ctx.cwd;
        const model = ctx.model?.name ?? ctx.model?.id ?? "select a model";
        const greeting = theme.bold(
          theme.fg("text", "Hi! ") +
          theme.fg("accent", "π") +
          theme.fg("muted", "(") +
          theme.fg("text", "yush") +
          theme.fg("muted", ")"),
        );
        // Never crop the lettering: switch to native text when it cannot fit.
        const title = width >= WORDMARK_WIDTH + 4 ? wordmark(theme) : [greeting];
        const innerWidth = Math.max(0, Math.min(WORDMARK_WIDTH, width - 4));
        const rule = theme.fg("accent", "─".repeat(Math.min(3, innerWidth))) +
          theme.fg("dim", "─".repeat(Math.max(0, innerWidth - 3)));
        const location = theme.fg("text", project);
        const engine = theme.fg("muted", model);
        const info = visibleWidth(location) + visibleWidth(engine) + 3 <= innerWidth
          ? location + " ".repeat(innerWidth - visibleWidth(location) - visibleWidth(engine)) + engine
          : location;
        const hint = theme.fg("muted", "/hotkeys") + theme.fg("dim", " for help");

        return [
          "",
          ...title.map((line) => `  ${line}`),
          `  ${rule}`,
          `  ${info}`,
          `  ${hint}`,
          "",
        ].map((line) => truncateToWidth(line, width));
      },
      // Colors are rebuilt on every render, including after a theme change.
      invalidate() {},
    }));
  });
}
