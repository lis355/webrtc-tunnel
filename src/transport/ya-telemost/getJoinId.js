export default function getJoinId(joinIdOrLink) {
	if (!joinIdOrLink) throw new Error("Join id or link is required");

	let joinId;

	if (typeof joinIdOrLink === "string" &&
		/^\d{14}$/.test(joinIdOrLink)) joinId = joinIdOrLink;

	try {
		const url = new URL(joinIdOrLink);
		if (url.href.startsWith("https://telemost.yandex.ru/j/")) joinId = url.pathname.split("/").at(-1);
	} catch {
	}

	if (!joinId) throw new Error("Invalid join id or link");

	return joinId;
}
