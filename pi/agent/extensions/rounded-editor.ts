import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

type EditorRenderState = {
	renderedVisibleLineCount: number;
};

class RoundedEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 3) return super.render(width);

		const innerWidth = width - 2;
		const lines = super.render(innerWidth);
		const visibleLineCount = (this as unknown as Partial<EditorRenderState>).renderedVisibleLineCount;

		// Keep pi-tui's layout and autocomplete rendering; only frame its output.
		if (!Number.isInteger(visibleLineCount) || visibleLineCount < 1) {
			return super.render(width);
		}

		const bottomIndex = visibleLineCount + 1;
		if (bottomIndex >= lines.length) return super.render(width);

		const side = (line: string) => this.borderColor("│") + line + this.borderColor("│");
		const top = this.borderColor("╭") + lines[0] + this.borderColor("╮");
		const bottom = this.borderColor("╰") + lines[bottomIndex] + this.borderColor("╯");
		const autocomplete = lines.slice(bottomIndex + 1).map((line) => ` ${line} `);

		return [top, ...lines.slice(1, bottomIndex).map(side), bottom, ...autocomplete];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < 3) return super.handleMouse(event);

		if (
			event.type === "click" &&
			event.button === "left" &&
			(event.x === 0 || event.x === event.width - 1)
		) {
			return { handled: true, focus: true };
		}

		return super.handleMouse({
			...event,
			x: event.x - 1,
			width: event.width - 2,
		});
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new RoundedEditor(tui, theme, keybindings),
		);
	});
}
