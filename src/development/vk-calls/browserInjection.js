const OriginalWebSocket = window.WebSocket;

window.WebSocket = function (url, protocols) {
	console.log("WebSocket connecting to:", url);

	const ws = new OriginalWebSocket(url, protocols);

	window._lastWebSocket = ws;

	ws.addEventListener("message", (event) => {
		let json;
		try {
			json = JSON.parse(event.data);
			console.log(json);
			if (json &&
				json.type === "notification"
				&& json.notification === "connection") {
				console.log("participantId", json.conversation.participants.find(participant => participant.peerId.id === json.peerId.id).id);
			}
		} catch {
		}
	});

	return ws;
};

window.WebSocket.prototype = OriginalWebSocket.prototype;
window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
window.WebSocket.OPEN = OriginalWebSocket.OPEN;
window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

window.sendWebSocketMessage = function (obj) {
	if (window._lastWebSocket && window._lastWebSocket.readyState === 1) {
		window._lastWebSocket.send(JSON.stringify(obj));
	}
};
