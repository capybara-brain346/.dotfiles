import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const SAMPLE_MS = 1_000;
const PANEL_WIDTH = 36;
const MIN_OVERLAY_WIDTH = 100;
const HISTORY_SIZE = 20;

type CpuTimes = { idle: number; total: number };
type NetworkBytes = { rx: number; tx: number };
type GpuStats = {
	load: number;
	memoryUsed: number;
	memoryTotal: number;
	temperature: number;
	power: number;
};
type Metrics = {
	cpu: number;
	cores: number[];
	memoryUsed: number;
	memoryTotal: number;
	swapUsed: number;
	swapTotal: number;
	networkDown: number;
	networkUp: number;
	networkAvailable: boolean;
	gpu?: GpuStats;
	history: number[];
};

const EMPTY_METRICS: Metrics = {
	cpu: 0,
	cores: [],
	memoryUsed: 0,
	memoryTotal: 0,
	swapUsed: 0,
	swapTotal: 0,
	networkDown: 0,
	networkUp: 0,
	networkAvailable: false,
	history: [],
};

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function computeRate(previous: number, current: number, elapsedSeconds: number): number {
	if (!Number.isFinite(previous) || !Number.isFinite(current) || elapsedSeconds <= 0 || current < previous) return 0;
	return (current - previous) / elapsedSeconds;
}

export function parseMeminfo(text: string): {
	total: number;
	available: number;
	swapTotal: number;
	swapFree: number;
} {
	const values = new Map<string, number>();
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z_]+):\s+(\d+)/);
		if (match) values.set(match[1]!, Number(match[2]) * 1024);
	}
	return {
		total: values.get("MemTotal") ?? 0,
		available: values.get("MemAvailable") ?? values.get("MemFree") ?? 0,
		swapTotal: values.get("SwapTotal") ?? 0,
		swapFree: values.get("SwapFree") ?? 0,
	};
}

export function parseDefaultInterface(routeText: string): string | undefined {
	for (const line of routeText.split(/\r?\n/).slice(1)) {
		const columns = line.trim().split(/\s+/);
		if (columns.length >= 2 && columns[1] === "00000000") return columns[0];
	}
	return undefined;
}

export function parseNetworkBytes(text: string, preferredInterface?: string): NetworkBytes | undefined {
	const rows = text.split(/\r?\n/).flatMap((line) => {
		const match = line.match(/^\s*([^:]+):\s*(.*)$/);
		if (!match) return [];
		const columns = match[2]!.trim().split(/\s+/);
		if (columns.length < 9 || match[1]!.trim() === "lo") return [];
		const rx = Number(columns[0]);
		const tx = Number(columns[8]);
		return Number.isFinite(rx) && Number.isFinite(tx)
			? [{ name: match[1]!.trim(), rx, tx }]
			: [];
	});
	if (rows.length === 0) return undefined;
	const selected = preferredInterface ? rows.filter((row) => row.name === preferredInterface) : rows;
	const source = selected.length > 0 ? selected : rows;
	return source.reduce((total, row) => ({ rx: total.rx + row.rx, tx: total.tx + row.tx }), { rx: 0, tx: 0 });
}

function readCpuTimes(): CpuTimes[] {
	return cpus().map(({ times }) => ({
		idle: times.idle,
		total: times.user + times.nice + times.sys + times.idle + times.irq,
	}));
}

function cpuUsage(previous: CpuTimes[] | undefined, current: CpuTimes[]): { total: number; cores: number[] } {
	if (!previous || previous.length !== current.length) return { total: 0, cores: current.map(() => 0) };
	const cores = current.map((sample, index) => {
		const old = previous[index]!;
		const totalDelta = sample.total - old.total;
		const idleDelta = sample.idle - old.idle;
		return totalDelta > 0 ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
	});
	return { total: cores.reduce((sum, value) => sum + value, 0) / Math.max(1, cores.length), cores };
}

async function readProcFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function readNvidiaGpu(): Promise<GpuStats | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"nvidia-smi",
			[
				"--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
				"--format=csv,noheader,nounits",
			],
			{ timeout: 900, windowsHide: true },
		);
		const values = String(stdout).trim().split(/\r?\n/)[0]?.split(",").map((value) => Number.parseFloat(value.trim()));
		if (!values || values.length < 5 || values.some((value) => !Number.isFinite(value))) return undefined;
		return {
			load: clampPercent(values[0]!),
			memoryUsed: values[1]! * 1024 * 1024,
			memoryTotal: values[2]! * 1024 * 1024,
			temperature: values[3]!,
			power: values[4]!,
		};
	} catch {
		return undefined;
	}
}

function formatGiB(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function formatRate(bytesPerSecond: number): string {
	if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)}B`;
	if (bytesPerSecond < 1024 ** 2) return `${(bytesPerSecond / 1024).toFixed(1)}K`;
	if (bytesPerSecond < 1024 ** 3) return `${(bytesPerSecond / 1024 ** 2).toFixed(1)}M`;
	return `${(bytesPerSecond / 1024 ** 3).toFixed(1)}G`;
}

function percentBar(theme: Theme, value: number, width = 8): string {
	const percent = clampPercent(value);
	const filled = Math.round((percent / 100) * width);
	const color = percent >= 90 ? "error" : percent >= 70 ? "warning" : "accent";
	return theme.fg(color, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(width - filled));
}

function sparkline(theme: Theme, values: readonly number[]): string {
	const glyphs = "▁▂▃▄▅▆▇█";
	return theme.fg("accent", values.map((value) => glyphs[Math.round((clampPercent(value) / 100) * (glyphs.length - 1))]).join(""));
}

function coreMatrix(theme: Theme, values: readonly number[]): string {
	const glyphs = " .·:+*#%@";
	return values.slice(0, 24).map((value) => {
		const level = Math.round((clampPercent(value) / 100) * (glyphs.length - 1));
		const color = value >= 90 ? "error" : value >= 70 ? "warning" : "accent";
		return theme.fg(color, glyphs[level]!);
	}).join("");
}

function lineFor(theme: Theme, content: string, width: number): string {
	const innerWidth = Math.max(1, width - 2);
	const fitted = truncateToWidth(content, innerWidth, "", true);
	const padded = fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
	return theme.bg("customMessageBg", `${theme.fg("border", "│")}${padded}${theme.fg("border", "│")}`);
}

function framed(theme: Theme, contents: string[], width: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const top = theme.bg("customMessageBg", theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`));
	const bottom = theme.bg("customMessageBg", theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`));
	return [top, ...contents.map((content) => lineFor(theme, content, width)), bottom];
}

class MonitorState {
	metrics: Metrics = EMPTY_METRICS;
	enabled = true;
	private previousCpu?: CpuTimes[];
	private previousNetwork?: NetworkBytes;
	private previousAt?: number;
	private networkInterface?: string;
	private gpuSupported: boolean | undefined;
	private interval?: ReturnType<typeof setInterval>;
	private updating = false;
	private onChange: () => void = () => {};

	setOnChange(onChange: () => void): void {
		this.onChange = onChange;
	}

	start(): void {
		if (this.interval) return;
		void this.sample();
		this.interval = setInterval(() => void this.sample(), SAMPLE_MS);
	}

	stop(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}

	async sample(): Promise<void> {
		if (this.updating) return;
		this.updating = true;
		try {
			const now = Date.now();
			const currentCpu = readCpuTimes();
			const cpu = cpuUsage(this.previousCpu, currentCpu);
			this.previousCpu = currentCpu;

			const [memText, routeText, networkText] = await Promise.all([
				readProcFile("/proc/meminfo"),
				readProcFile("/proc/net/route"),
				readProcFile("/proc/net/dev"),
			]);
			const memory = memText ? parseMeminfo(memText) : {
				total: totalmem(),
				available: freemem(),
				swapTotal: 0,
				swapFree: 0,
			};
			if (!this.networkInterface && routeText) this.networkInterface = parseDefaultInterface(routeText);
			const network = networkText ? parseNetworkBytes(networkText, this.networkInterface) : undefined;
			const elapsed = this.previousAt ? (now - this.previousAt) / 1000 : 0;
			const gpu = this.gpuSupported === false ? undefined : await readNvidiaGpu();
			if (this.gpuSupported === undefined) this.gpuSupported = gpu !== undefined;
			this.metrics = {
				cpu: cpu.total,
				cores: cpu.cores,
				memoryUsed: Math.max(0, memory.total - memory.available),
				memoryTotal: memory.total,
				swapUsed: Math.max(0, memory.swapTotal - memory.swapFree),
				swapTotal: memory.swapTotal,
				networkDown: network && this.previousNetwork ? computeRate(this.previousNetwork.rx, network.rx, elapsed) : 0,
				networkUp: network && this.previousNetwork ? computeRate(this.previousNetwork.tx, network.tx, elapsed) : 0,
				networkAvailable: network !== undefined,
				gpu,
				history: [...this.metrics.history, cpu.total].slice(-HISTORY_SIZE),
			};
			this.previousNetwork = network;
			this.previousAt = now;
			this.onChange();
		} finally {
			this.updating = false;
		}
	}
}

class MonitorPanel {
	constructor(private readonly state: MonitorState, private readonly theme: Theme) {}

	render(width: number): string[] {
		const metrics = this.state.metrics;
		const gpu = metrics.gpu;
		const title = this.theme.fg("accent", this.theme.bold(" EDGE//SYSTEM MONITOR"));
		const lines = [
			` ${title}`,
			this.theme.fg("muted", " CPU ") + `${Math.round(metrics.cpu).toString().padStart(3)}% ` + percentBar(this.theme, metrics.cpu),
			this.theme.fg("muted", " CORE ") + (metrics.cores.length ? coreMatrix(this.theme, metrics.cores) : this.theme.fg("dim", "sampling")),
			this.theme.fg("muted", " RAM ") + `${formatGiB(metrics.memoryUsed)} / ${formatGiB(metrics.memoryTotal)} ` + percentBar(this.theme, metrics.memoryTotal ? metrics.memoryUsed / metrics.memoryTotal * 100 : 0),
			this.theme.fg("muted", " SWP ") + (metrics.swapTotal ? `${formatGiB(metrics.swapUsed)} / ${formatGiB(metrics.swapTotal)}` : this.theme.fg("dim", "n/a")),
			this.theme.fg("muted", " GPU ") + (gpu ? `${Math.round(gpu.load).toString().padStart(3)}% ${Math.round(gpu.temperature)}°C ${Math.round(gpu.power)}W` : this.theme.fg("dim", "n/a")),
			this.theme.fg("muted", " VRM ") + (gpu ? `${formatGiB(gpu.memoryUsed)} / ${formatGiB(gpu.memoryTotal)}` : this.theme.fg("dim", "n/a")),
			this.theme.fg("muted", " NET ") + (metrics.networkAvailable ? `↓${formatRate(metrics.networkDown)} ↑${formatRate(metrics.networkUp)}` : this.theme.fg("dim", "n/a")),
			this.theme.fg("muted", " HIST ") + (metrics.history.length ? sparkline(this.theme, metrics.history) : this.theme.fg("dim", "sampling")),
		];
		return framed(this.theme, lines, Math.min(PANEL_WIDTH, Math.max(20, width)));
	}

	invalidate(): void {}
}

class CompactPanel {
	constructor(private readonly state: MonitorState, private readonly theme: Theme) {}

	render(width: number): string[] {
		if (!this.state.enabled || width >= MIN_OVERLAY_WIDTH) return [];
		const metrics = this.state.metrics;
		const gpu = metrics.gpu ? ` GPU ${Math.round(metrics.gpu.load)}%` : "";
		const network = metrics.networkAvailable ? ` ↓${formatRate(metrics.networkDown)} ↑${formatRate(metrics.networkUp)}` : "";
		return [
			truncateToWidth(
				this.theme.fg("accent", "EDGE//SYS ") +
					`CPU ${Math.round(metrics.cpu)}% RAM ${metrics.memoryTotal ? Math.round(metrics.memoryUsed / metrics.memoryTotal * 100) : 0}%${gpu}${network}`,
				width,
			),
		];
	}

	invalidate(): void {}
}

export function runSelfCheck(): string {
	const memory = parseMeminfo("MemTotal: 1024 kB\nMemAvailable: 256 kB\nSwapTotal: 512 kB\nSwapFree: 128 kB");
	assert.equal(memory.total, 1024 * 1024);
	assert.equal(memory.available, 256 * 1024);
	assert.equal(memory.swapTotal - memory.swapFree, 384 * 1024);
	assert.deepEqual(parseNetworkBytes("Inter-| Receive | Transmit\n eth0: 100 0 0 0 0 0 0 0 200 0 0"), { rx: 100, tx: 200 });
	assert.equal(parseDefaultInterface("Iface\tDestination\nwl0\t00000000\t00000000"), "wl0");
	assert.equal(computeRate(100, 250, 5), 30);
	assert.equal(clampPercent(140), 100);
	return "self-check passed";
}

export default function (pi: ExtensionAPI) {
	let state: MonitorState | undefined;
	let overlay: ReturnType<TUI["showOverlay"]> | undefined;
	let planEnabled = false;
	let enabledBeforePlan = true;

	pi.events.on("plan-mode:change", (data) => {
		const { enabled } = data as { enabled: boolean };
		if (enabled && !planEnabled) enabledBeforePlan = state?.enabled ?? true;
		planEnabled = enabled;
		if (!state || !overlay) return;
		state.enabled = enabled ? false : enabledBeforePlan;
		overlay.setHidden(!state.enabled);
		if (state.enabled) state.start();
		else state.stop();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget("edgerunners-system-monitor", (tui, theme) => {
			const nextState = new MonitorState();
			nextState.enabled = !planEnabled;
			const panel = new MonitorPanel(nextState, theme);
			const compact = new CompactPanel(nextState, theme);
			nextState.setOnChange(() => tui.requestRender());
			state = nextState;
			overlay = tui.showOverlay(panel, {
				anchor: "top-right",
				width: PANEL_WIDTH,
				maxHeight: 12,
				margin: { top: 1, right: 1 },
				nonCapturing: true,
				visible: (termWidth) => nextState.enabled && termWidth >= MIN_OVERLAY_WIDTH,
			});
			if (nextState.enabled) nextState.start();
			return {
				render: (width: number) => compact.render(width),
				invalidate: () => {
					panel.invalidate();
					compact.invalidate();
				},
				dispose: () => {
					overlay = undefined;
					nextState.stop();
					if (state === nextState) state = undefined;
				},
			};
		}, { placement: "belowEditor" });
	});

	pi.registerCommand("sysmon", {
		description: "Toggle the Edgerunners system monitor: on, off, or test",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "test") {
				ctx.ui.notify(runSelfCheck(), "info");
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /sysmon [on|off|test]", "error");
				return;
			}
			if (!state || !overlay) {
				ctx.ui.notify("System monitor is only available in interactive TUI mode.", "warning");
				return;
			}
			state.enabled = action === "on";
			overlay.setHidden(!state.enabled);
			if (state.enabled) state.start();
			else state.stop();
			ctx.ui.notify(`System monitor ${state.enabled ? "online" : "offline"}.`, "info");
		},
	});

	pi.on("session_shutdown", (event) => {
		state?.stop();
		state = undefined;
		overlay = undefined;
		if (event.reason === "quit") process.once("exit", () => process.stdout.write("\x1b[?25h"));
	});
}
