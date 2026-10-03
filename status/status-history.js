const VALID_STATUSES = new Set(["operational", "outage"]);

export const calculateObservedUptime = (samples, componentId) => {
	const observed = samples
		.map((sample) => sample?.components?.[componentId])
		.filter((status) => VALID_STATUSES.has(status));
	if (observed.length === 0) return null;

	const operational = observed.filter(
		(status) => status === "operational",
	).length;
	return (operational / observed.length) * 100;
};

export const buildDailyHistory = (
	samples,
	componentId,
	days = 30,
	now = new Date(),
) => {
	const endDayMs = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	const startDayMs = endDayMs - (days - 1) * 24 * 60 * 60 * 1_000;
	const daily = Array.from({ length: days }, (_, index) => ({
		date: new Date(startDayMs + index * 24 * 60 * 60 * 1_000)
			.toISOString()
			.slice(0, 10),
		status: null,
		sampleCount: 0,
	}));

	for (const sample of samples) {
		const checkedAtMs = Date.parse(sample?.checkedAt);
		const status = sample?.components?.[componentId];
		if (!Number.isFinite(checkedAtMs) || !VALID_STATUSES.has(status)) continue;

		const checkedDate = new Date(checkedAtMs);
		const sampleDayMs = Date.UTC(
			checkedDate.getUTCFullYear(),
			checkedDate.getUTCMonth(),
			checkedDate.getUTCDate(),
		);
		const index = Math.floor(
			(sampleDayMs - startDayMs) / (24 * 60 * 60 * 1_000),
		);
		if (index < 0 || index >= daily.length) continue;

		daily[index].sampleCount += 1;
		if (status === "outage" || daily[index].status === null) {
			daily[index].status = status;
		}
	}

	return daily;
};
