import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildStatusPage,
	checkTargetOnce,
	mergeHistory,
	resolveOverallStatus,
	type StatusComponent,
	type StatusHistory,
	type StatusSnapshot,
} from "./build-status-page";
import {
	buildDailyHistory,
	calculateObservedUptime,
} from "../site/status-history.js";

const component = (
	id: string,
	status: StatusComponent["status"],
): StatusComponent => ({
	id,
	name: id,
	status,
	statusCode: status === "operational" ? 200 : 503,
	latencyMs: 10,
});

describe("public status page", () => {
	test("publishes from this repository without cross-repository credentials", async () => {
		const workflow = await readFile(
			join(import.meta.dir, "..", ".github", "workflows", "status-page.yml"),
			"utf8",
		);

		expect(workflow).toContain("contents: write");
		expect(workflow).toContain("pages: write");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("${GITHUB_REPOSITORY}.git");
		expect(workflow).toContain("${{ github.token }}");
		expect(workflow).toContain("actions/upload-pages-artifact@v4");
		expect(workflow).toContain("actions/deploy-pages@v4");
		expect(workflow).not.toContain("STATUS_PAGE_DEPLOY_KEY");
		expect(workflow).not.toContain("SIV-chat/platform");
	});

	test("treats only successful HTTP responses as operational", async () => {
		const target = { id: "api", name: "API", url: "https://example.com" };
		const healthy = await checkTargetOnce(target, () =>
			Promise.resolve(new Response("ok", { status: 200 })),
		);
		const unavailable = await checkTargetOnce(target, () =>
			Promise.resolve(new Response("down", { status: 503 })),
		);

		expect(healthy.status).toBe("operational");
		expect(unavailable.status).toBe("outage");
	});

	test("distinguishes partial and complete outages", () => {
		expect(
			resolveOverallStatus([
				component("app", "operational"),
				component("api", "operational"),
			]),
		).toBe("operational");
		expect(
			resolveOverallStatus([
				component("app", "operational"),
				component("api", "outage"),
			]),
		).toBe("degraded");
		expect(
			resolveOverallStatus([
				component("app", "outage"),
				component("api", "outage"),
			]),
		).toBe("outage");
	});

	test("builds a publishable snapshot without exposing failure details", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "siv-status-page-"));
		const snapshot = await buildStatusPage(outputDir, () =>
			Promise.resolve(new Response("ok", { status: 200 })),
		);
		const statusOutputDir = join(outputDir, "status");
		const published = JSON.parse(
			await readFile(join(statusOutputDir, "status.json"), "utf8"),
		) as typeof snapshot;
		const pageHtml = await readFile(
			join(statusOutputDir, "index.html"),
			"utf8",
		);

		expect(snapshot.overall).toBe("operational");
		expect(published.components).toHaveLength(3);
		expect(pageHtml).toContain("Siv service status");
		expect(pageHtml).toContain("https://sivintelligence.se/status/");
		expect(pageHtml).not.toContain("status.siv.chat");
		expect(await readFile(join(outputDir, "index.html"), "utf8")).toContain(
			"url=./status/",
		);
		expect(await readFile(join(outputDir, ".nojekyll"), "utf8")).toBe("");
		expect(
			await readFile(join(statusOutputDir, "favicon.svg"), "utf8"),
		).toContain("Siv service status");
		const history = JSON.parse(
			await readFile(join(statusOutputDir, "history.json"), "utf8"),
		) as StatusHistory;
		expect(history.retentionDays).toBe(90);
		expect(history.samples).toHaveLength(1);
		expect(history.samples[0]?.components).toEqual({
			app: "operational",
			api: "operational",
			website: "operational",
		});
	});

	test("restores retained history into a later build", async () => {
		const firstOutputDir = await mkdtemp(join(tmpdir(), "siv-status-first-"));
		const secondOutputDir = await mkdtemp(join(tmpdir(), "siv-status-second-"));
		const fetchHealthy = () =>
			Promise.resolve(new Response("ok", { status: 200 }));

		await buildStatusPage(firstOutputDir, fetchHealthy);
		const firstHistoryPath = join(firstOutputDir, "status", "history.json");
		const firstHistory = JSON.parse(
			await readFile(firstHistoryPath, "utf8"),
		) as StatusHistory;
		const priorCheck = new Date(Date.now() - 60_000).toISOString();
		firstHistory.generatedAt = priorCheck;
		if (firstHistory.samples[0]) {
			firstHistory.samples[0].checkedAt = priorCheck;
		}
		await writeFile(firstHistoryPath, JSON.stringify(firstHistory), "utf8");
		await buildStatusPage(secondOutputDir, fetchHealthy, firstHistoryPath);

		const history = JSON.parse(
			await readFile(join(secondOutputDir, "status", "history.json"), "utf8"),
		) as StatusHistory;
		expect(history.samples).toHaveLength(2);
	});

	test("refuses to replace malformed retained history", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "siv-status-malformed-"));
		const historyPath = join(outputDir, "previous-history.json");
		await writeFile(historyPath, '{"schemaVersion":1,"samples":[]}', "utf8");

		expect(
			buildStatusPage(
				outputDir,
				() => Promise.resolve(new Response("ok", { status: 200 })),
				historyPath,
			),
		).rejects.toThrow("Invalid public uptime history");
	});

	test("prunes expired and future samples from the rolling history", () => {
		const previous: StatusHistory = {
			schemaVersion: 1,
			generatedAt: "2026-08-09T12:00:00.000Z",
			retentionDays: 90,
			samples: [
				{
					checkedAt: "2026-04-01T12:00:00.000Z",
					components: { api: "operational" },
				},
				{
					checkedAt: "2026-08-09T12:00:00.000Z",
					components: { api: "outage" },
				},
				{
					checkedAt: "2026-08-11T12:00:00.000Z",
					components: { api: "operational" },
				},
			],
		};
		const snapshot: StatusSnapshot = {
			schemaVersion: 1,
			checkedAt: "2026-08-10T12:00:00.000Z",
			overall: "operational",
			components: [component("api", "operational")],
		};

		expect(
			mergeHistory(previous, snapshot).samples.map(
				(sample) => sample.checkedAt,
			),
		).toEqual(["2026-08-09T12:00:00.000Z", "2026-08-10T12:00:00.000Z"]);
	});

	test("calculates observed uptime and daily interruption history", () => {
		const samples = [
			{
				checkedAt: "2026-08-08T01:00:00.000Z",
				components: { api: "operational" },
			},
			{
				checkedAt: "2026-08-09T01:00:00.000Z",
				components: { api: "operational" },
			},
			{
				checkedAt: "2026-08-09T02:00:00.000Z",
				components: { api: "outage" },
			},
		];

		expect(calculateObservedUptime(samples, "api")).toBeCloseTo(66.667, 3);
		expect(
			buildDailyHistory(
				samples,
				"api",
				3,
				new Date("2026-08-10T12:00:00.000Z"),
			).map((day) => day.status),
		).toEqual(["operational", "outage", null]);
	});
});
