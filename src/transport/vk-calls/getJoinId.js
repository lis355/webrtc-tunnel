export default function getJoinId(joinIdOrLink) {
	if (!joinIdOrLink) throw new Error("Join id or link is required");

	let joinId = joinIdOrLink;

	try {
		const url = new URL(joinIdOrLink);
		if (url.href.startsWith("https://vk.com/call/join/")) joinId = url.pathname.split("/").at(-1);
	} catch {
	}

	return joinId;
}
