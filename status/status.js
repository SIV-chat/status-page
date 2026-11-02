import {
	buildDailyHistory,
	calculateObservedUptime,
} from "./status-history.js";

const STALE_AFTER_MS = 15 * 60 * 1000;

const statusCopy = {
	operational: {
		title: "All systems operational",
		summary:
			"The production app, API, and public website are responding normally.",
		label: "Operational",
	},
	degraded: {
		title: "Some systems are degraded",
		summary: "One or more production services are responding inconsistently.",
		label: "Degraded",
	},
	outage: {
		title: "Service interruption",
		summary: "One or more production services are currently unavailable.",
		label: "Unavailable",
	},
	stale: {
		title: "Status update delayed",
		summary:
			"The external status publisher has not reported recently. The service states below are the last known results.",
		label: "Last known",
	},
};

const root = document.documentElement;
const overallTitle = document.querySelector("#overall-title");
const overallSummary = document.querySelector("#overall-summary");
const componentList = document.querySelector("#component-list");
const historyList = document.querySelector("#history-list");
const checkedAt = document.querySelector("#checked-at");

const setOverall = (status) => {
	const copy = statusCopy[status] ?? statusCopy.stale;
	root.dataset.status = status;
	overallTitle.textContent = copy.title;
	overallSummary.textContent = copy.summary;
};

const uptimeLabel = (samples, componentId) => {
	const uptime = calculateObservedUptime(samples, componentId);
	return uptime === null
		? "History starting"
		: `${uptime.toFixed(3)}% observed uptime`;
};

const renderComponents = (components, stale, samples) => {
	componentList.replaceChildren(
		...components.map((component) => {
			const row = document.createElement("article");
			row.className = "component";
			row.dataset.status = component.status;

			const mark = document.createElement("span");
			mark.className = "component-mark";
			mark.setAttribute("aria-hidden", "true");

			const name = document.createElement("span");
			name.className = "component-name";
			name.textContent = component.name;

			const uptime = document.createElement("span");
			uptime.className = "component-uptime";
			uptime.textContent = uptimeLabel(samples, component.id);

			const state = document.createElement("span");
			state.className = "component-state";
			state.textContent = stale
				? statusCopy.stale.label
				: (statusCopy[component.status]?.label ?? statusCopy.stale.label);

			row.append(mark, name, uptime, state);
			return row;
		}),
	);
};

const renderHistory = (components, samples) => {
	historyList.replaceChildren(
		...components.map((component) => {
			const row = document.createElement("article");
			row.className = "history-row";

			const heading = document.createElement("div");
			heading.className = "history-row-heading";
			const name = document.createElement("strong");
			name.textContent = component.name;
			const uptime = document.createElement("span");
			uptime.textContent =
				calculateObservedUptime(samples, component.id) === null
					? "No observed history yet"
					: uptimeLabel(samples, component.id);
			heading.append(name, uptime);

			const days = document.createElement("div");
			days.className = "history-days";
			days.setAttribute("role", "list");
			days.setAttribute("aria-label", `${component.name} daily uptime history`);
			for (const day of buildDailyHistory(samples, component.id)) {
				const cell = document.createElement("span");
				const state = day.status ?? "unknown";
				cell.className = "history-day";
				cell.setAttribute("role", "listitem");
				cell.dataset.historyStatus = state;
				cell.title = `${day.date}: ${
					state === "operational"
						? "operational"
						: state === "outage"
							? "interruption observed"
							: "no data"
				}`;
				cell.setAttribute("aria-label", cell.title);
				days.append(cell);
			}

			row.append(heading, days);
			return row;
		}),
	);
};

const loadHistory = async () => {
	try {
		const response = await fetch("./history.json", { cache: "no-store" });
		if (!response.ok) return [];
		const history = await response.json();
		return Array.isArray(history.samples) ? history.samples : [];
	} catch {
		return [];
	}
};

try {
	const historyPromise = loadHistory();
	const response = await fetch("./status.json", { cache: "no-store" });
	if (!response.ok) throw new Error("Status data unavailable");
	const snapshot = await response.json();
	const samples = await historyPromise;
	const checkedDate = new Date(snapshot.checkedAt);
	const stale =
		Number.isNaN(checkedDate.valueOf()) ||
		Date.now() - checkedDate.valueOf() > STALE_AFTER_MS;

	setOverall(stale ? "stale" : snapshot.overall);
	renderComponents(snapshot.components, stale, samples);
	renderHistory(snapshot.components, samples);
	checkedAt.dateTime = snapshot.checkedAt;
	checkedAt.textContent = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(checkedDate);
} catch {
	setOverall("stale");
	componentList.textContent = "No recent external status result is available.";
	historyList.textContent =
		"Historical status data is temporarily unavailable.";
	checkedAt.textContent = "Unavailable";
}
