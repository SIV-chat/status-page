import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ComponentStatus = "operational" | "outage";
export type OverallStatus = "operational" | "degraded" | "outage";

export interface StatusComponent {
	id: string;
	name: string;
	status: ComponentStatus;
	statusCode: number | null;
	latencyMs: number;
}

export interface StatusSnapshot {
	schemaVersion: 1;
	checkedAt: string;
	overall: OverallStatus;
	components: StatusComponent[];
}

export interface HistoricalStatusSample {
	checkedAt: string;
	components: Record<string, ComponentStatus>;
}

export interface StatusHistory {
	schemaVersion: 1;
	generatedAt: string;
	retentionDays: 90;
	samples: HistoricalStatusSample[];
}

interface StatusTarget {
	id: string;
	name: string;
	url: string;
}

const rootDir = resolve(import.meta.dir, "..");
const sourceDir = join(rootDir, "site");
const defaultOutputDir = join(rootDir, "dist");
const statusPath = "status";
const customDomain = "sivintelligence.se";
const maxAttempts = 3;
const historyRetentionDays = 90;
const historyRetentionMs = historyRetentionDays * 24 * 60 * 60 * 1_000;

export const productionStatusTargets: StatusTarget[] = [
	{
		id: "app",
		name: "Product application",
		url: "https://app.siv.chat/auth/sign-in",
	},
	{
		id: "api",
		name: "API and database",
		url: "https://api.siv.chat/api/health",
	},
	{
		id: "website",
		name: "Public website",
		url: "https://siv.chat/",
	},
];

export const resolveOverallStatus = (
	components: StatusComponent[],
): OverallStatus => {
	const outageCount = components.filter(
		(component) => component.status === "outage",
	).length;
	if (outageCount === 0) return "operational";
	if (outageCount === components.length) return "outage";
	return "degraded";
};

export const checkTargetOnce = async (
	target: StatusTarget,
	fetchImpl: typeof fetch = fetch,
): Promise<StatusComponent> => {
	const startedAt = performance.now();
	try {
		const response = await fetchImpl(target.url, {
			method: "GET",
			redirect: "follow",
			cache: "no-store",
			signal: AbortSignal.timeout(10_000),
			headers: { "user-agent": "Siv external status page/1.0" },
		});
		return {
			id: target.id,
			name: target.name,
			status:
				response.status >= 200 && response.status < 300
					? "operational"
					: "outage",
			statusCode: response.status,
			latencyMs: Math.round(performance.now() - startedAt),
		};
	} catch {
		return {
			id: target.id,
			name: target.name,
			status: "outage",
			statusCode: null,
			latencyMs: Math.round(performance.now() - startedAt),
		};
	}
};

const delay = (milliseconds: number): Promise<void> =>
	new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const checkTargetWithRetries = async (
	target: StatusTarget,
	fetchImpl: typeof fetch,
	attempt = 1,
): Promise<StatusComponent> => {
	const result = await checkTargetOnce(target, fetchImpl);
	if (result.status === "operational" || attempt >= maxAttempts) return result;
	await delay(2_000);
	return checkTargetWithRetries(target, fetchImpl, attempt + 1);
};

const emptyHistory = (generatedAt: string): StatusHistory => ({
	schemaVersion: 1,
	generatedAt,
	retentionDays: historyRetentionDays,
	samples: [],
});

const parseHistory = (raw: string, source: string): StatusHistory => {
	const value = JSON.parse(raw) as Partial<StatusHistory>;
	if (
		value.schemaVersion !== 1 ||
		typeof value.generatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.generatedAt)) ||
		value.retentionDays !== historyRetentionDays ||
		!Array.isArray(value.samples) ||
		!value.samples.every(
			(sample) =>
				typeof sample === "object" &&
				sample !== null &&
				typeof sample.checkedAt === "string" &&
				Number.isFinite(Date.parse(sample.checkedAt)) &&
				typeof sample.components === "object" &&
				sample.components !== null &&
				Object.values(sample.components).every(
					(status) => status === "operational" || status === "outage",
				),
		)
	) {
		throw new Error(`Invalid public uptime history: ${source}`);
	}
	return value as StatusHistory;
};

const readPreviousHistory = async (
	historyPath: string | undefined,
	generatedAt: string,
): Promise<StatusHistory> => {
	if (!historyPath) return emptyHistory(generatedAt);
	try {
		return parseHistory(await readFile(historyPath, "utf8"), historyPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return emptyHistory(generatedAt);
		}
		throw error;
	}
};

export const mergeHistory = (
	previous: StatusHistory,
	snapshot: StatusSnapshot,
): StatusHistory => {
	const checkedAtMs = Date.parse(snapshot.checkedAt);
	const cutoffMs = checkedAtMs - historyRetentionMs;
	const retainedSamples = previous.samples.filter((sample) => {
		const sampleTime = Date.parse(sample.checkedAt);
		return (
			Number.isFinite(sampleTime) &&
			sampleTime >= cutoffMs &&
			sampleTime <= checkedAtMs &&
			sample.checkedAt !== snapshot.checkedAt
		);
	});
	const sample: HistoricalStatusSample = {
		checkedAt: snapshot.checkedAt,
		components: Object.fromEntries(
			snapshot.components.map((component) => [component.id, component.status]),
		),
	};

	return {
		schemaVersion: 1,
		generatedAt: snapshot.checkedAt,
		retentionDays: historyRetentionDays,
		samples: [...retainedSamples, sample],
	};
};

export const buildStatusPage = async (
	outputDir = defaultOutputDir,
	fetchImpl: typeof fetch = fetch,
	historyPath = process.env.STATUS_PAGE_HISTORY_PATH,
): Promise<StatusSnapshot> => {
	const components = await Promise.all(
		productionStatusTargets.map((target) =>
			checkTargetWithRetries(target, fetchImpl),
		),
	);
	const snapshot: StatusSnapshot = {
		schemaVersion: 1,
		checkedAt: new Date().toISOString(),
		overall: resolveOverallStatus(components),
		components,
	};
	const previousHistory = await readPreviousHistory(
		historyPath,
		snapshot.checkedAt,
	);
	const history = mergeHistory(previousHistory, snapshot);
	const statusOutputDir = join(outputDir, statusPath);

	await mkdir(statusOutputDir, { recursive: true });
	await Promise.all([
		cp(join(sourceDir, "root-index.html"), join(outputDir, "index.html")),
		cp(join(sourceDir, "index.html"), join(statusOutputDir, "index.html")),
		cp(join(sourceDir, "styles.css"), join(statusOutputDir, "styles.css")),
		cp(join(sourceDir, "status.js"), join(statusOutputDir, "status.js")),
		cp(
			join(sourceDir, "status-history.js"),
			join(statusOutputDir, "status-history.js"),
		),
		cp(join(sourceDir, "favicon.svg"), join(statusOutputDir, "favicon.svg")),
		writeFile(join(outputDir, ".nojekyll"), "", "utf8"),
		writeFile(join(outputDir, "CNAME"), `${customDomain}\n`, "utf8"),
		writeFile(
			join(statusOutputDir, "status.json"),
			`${JSON.stringify(snapshot, null, 2)}\n`,
			"utf8",
		),
		writeFile(
			join(statusOutputDir, "history.json"),
			`${JSON.stringify(history)}\n`,
			"utf8",
		),
	]);

	return snapshot;
};

if (import.meta.main) {
	const outputDir = process.argv[2]
		? resolve(process.argv[2])
		: defaultOutputDir;
	const snapshot = await buildStatusPage(outputDir);
	console.log(
		`Built ${outputDir} with overall status ${snapshot.overall} at ${snapshot.checkedAt}`,
	);
}
