import EventEmitter from "events";

import ws from "ws";

import { WebRTCTransport } from "../webrtc/WebRTCTransport.js";
import symmetricChipher from "../../utils/symmetricChipher.js";

export function getJoinId(joinIdOrLink) {
	if (!joinIdOrLink) throw new Error("Join id or link is required");

	let joinId = joinIdOrLink;

	try {
		const url = new URL(joinIdOrLink);
		if (url.href.startsWith("https://vk.com/call/join/")) joinId = url.pathname.split("/").at(-1);
	} catch (_) {
	}

	return joinId;
}

async function getVkWebSocketSignalServerUrlByJoinId(joinId) {
	const applicationKey = "CGMMEJLGDIHBABABA";
	const clientSecret = "QbYic1K3lEV5kTGiqlq2";
	const clientId = "6287487";
	const appId = "6287487";

	const deviceId = crypto.randomUUID();
	const username = "Anonym " + deviceId.slice(0, 4);

	async function postJson(url, params) {
		const response = await fetch(url, {
			method: "POST",
			body: new URLSearchParams(params)
		});

		const json = await response.json();

		// console.log("POST", url);
		// console.log(JSON.stringify(params, null, 2));
		// console.log(JSON.stringify(json, null, 2));

		return json;
	}

	const responses = {};

	responses["https://login.vk.com/?act=get_anonym_token__1"] = await postJson("https://login.vk.com/?act=get_anonym_token", {
		"client_secret": clientSecret,
		"client_id": clientId,
		"app_id": appId,
		"version": "1",

		"scopes": "audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous",
		"isApiOauthAnonymEnabled": "false"
	});

	responses["https://api.vk.com/method/calls.getAnonymousAccessTokenPayload"] = await postJson("https://api.vk.com/method/calls.getAnonymousAccessTokenPayload?v=5.265&client_id=6287487", {
		"access_token": responses["https://login.vk.com/?act=get_anonym_token__1"]["data"]["access_token"]
	});

	responses["https://login.vk.com/?act=get_anonym_token__2"] = await postJson("https://login.vk.com/?act=get_anonym_token", {
		"client_secret": clientSecret,
		"client_id": clientId,
		"app_id": appId,
		"version": "1",

		"token_type": "messages",
		"payload": responses["https://api.vk.com/method/calls.getAnonymousAccessTokenPayload"]["response"]["payload"]
	});

	responses["https://api.vk.com/method/calls.getAnonymousToken"] = await postJson("https://api.vk.com/method/calls.getAnonymousToken?v=5.265&client_id=6287487", {
		"vk_join_link": "https://vk.com/call/join/" + joinId,
		"name": username,
		"access_token": responses["https://login.vk.com/?act=get_anonym_token__2"]["data"]["access_token"]
	});

	responses["https://calls.okcdn.ru/fb.do__auth.anonymLogin"] = await postJson("https://calls.okcdn.ru/fb.do", {
		"method": "auth.anonymLogin",
		"format": "JSON",
		"application_key": applicationKey,
		"session_data": JSON.stringify({
			"version": 2,
			"device_id": deviceId,
			"client_version": 1.1,
			"client_type": "SDK_JS"
		})
	});

	responses["https://calls.okcdn.ru/fb.do__vchat.joinConversationByLink"] = await postJson("https://calls.okcdn.ru/fb.do", {
		"method": "vchat.joinConversationByLink",
		"format": "JSON",
		"application_key": applicationKey,
		"session_key": responses["https://calls.okcdn.ru/fb.do__auth.anonymLogin"]["session_key"],
		"joinLink": joinId,
		"isVideo": false,
		"protocolVersion": 5,
		"anonymToken": responses["https://api.vk.com/method/calls.getAnonymousToken"]["response"]["token"]
	});

	const webSocketUrl = responses["https://calls.okcdn.ru/fb.do__vchat.joinConversationByLink"]["endpoint"] + "&platform=WEB&appVersion=1.1&version=5&device=browser&capabilities=2F7F&clientType=VK&tgt=join";

	return webSocketUrl;
}

class VkWebSocketSignalServer extends EventEmitter {
	constructor(webSocketUrl) {
		super();

		this.webSocketUrl = new URL(webSocketUrl);

		this.handleWebSocketOnError = this.handleWebSocketOnError.bind(this);
		this.handleWebSocketOnOpen = this.handleWebSocketOnOpen.bind(this);
		this.handleWebSocketOnClose = this.handleWebSocketOnClose.bind(this);
		this.handleWebSocketOnMessage = this.handleWebSocketOnMessage.bind(this);
	}

	start() {
		this.webSocket = new ws.WebSocket(this.webSocketUrl.href);
		this.webSocket
			.on("error", this.handleWebSocketOnError)
			.on("open", this.handleWebSocketOnOpen)
			.on("close", this.handleWebSocketOnClose)
			.on("message", this.handleWebSocketOnMessage);

		this.commandNumber = 0;
	}

	stop() {
		this.webSocket
			.off("error", this.handleWebSocketOnError)
			.off("open", this.handleWebSocketOnOpen)
			.off("close", this.handleWebSocketOnClose)
			.off("message", this.handleWebSocketOnMessage);

		this.webSocket.close();
		this.webSocket = null;
	}

	handleWebSocketOnError(error) {
		this.emit("error", error);
	}

	handleWebSocketOnOpen() {
		this.emit("open");
	}

	handleWebSocketOnClose() {
		this.emit("close");
	}

	handleWebSocketOnMessage(data) {
		try {
			data = data.toString();
		} catch (_) {
			log("VkWebSocketSignalServer", "recieve unknown message");

			return;
		}

		let json;
		try {
			json = JSON.parse(data);
		} catch (_) {
		}

		log("VkWebSocketSignalServer", "recieve", data);

		if (data === "ping") this.send("pong");

		if (json) this.emit("message", json);

		if (json &&
			json.type === "notification") {
			this.emit("notification", json);

			if (json.notification === "connection") {
				this.connectionInfo = json;
				this.peerId = this.connectionInfo.peerId.id;
				this.participantId = this.connectionInfo.conversation.participants.find(participant => participant.peerId.id === this.peerId).id;
				this.conversationId = this.connectionInfo.conversation.id;

				this.emit("ready");
			}
		}
	}

	send(data) {
		log("VkWebSocketSignalServer", "send", data);

		this.webSocket.send(data);
	}

	sendJson(json) {
		this.send(JSON.stringify(json));
	}

	sendCommand(command, data) {
		this.commandNumber++;

		this.sendJson({
			command: command,
			sequence: this.commandNumber,
			...data
		});
	}
}

export class VkWebRTCTransport extends WebRTCTransport {
	constructor(joinId) {
		super();

		this.joinId = joinId;

		this.handleOnSdpOffer = this.handleOnSdpOffer.bind(this);
		this.handleOnSdpAnswer = this.handleOnSdpAnswer.bind(this);
		this.handleVkWebSocketSignalServerOnError = this.handleVkWebSocketSignalServerOnError.bind(this);
		this.handleVkWebSocketSignalServerOnStarted = this.handleVkWebSocketSignalServerOnStarted.bind(this);
		this.handleVkWebSocketSignalServerOnStopped = this.handleVkWebSocketSignalServerOnStopped.bind(this);
		this.handleVkWebSocketSignalServerOnReady = this.handleVkWebSocketSignalServerOnReady.bind(this);
		this.handleVkWebSocketSignalServerOnNotification = this.handleVkWebSocketSignalServerOnNotification.bind(this);

		this.on("sdp.offer", this.handleOnSdpOffer);
		this.on("sdp.answer", this.handleOnSdpAnswer);
	}

	async startConnection() {
		this.webSocketUrl = await getVkWebSocketSignalServerUrlByJoinId(this.joinId);

		this.vkWebSocketSignalServer = new VkWebSocketSignalServer(this.webSocketUrl);
		this.vkWebSocketSignalServer
			.on("error", this.handleVkWebSocketSignalServerOnError)
			.on("started", this.handleVkWebSocketSignalServerOnStarted)
			.on("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.on("ready", this.handleVkWebSocketSignalServerOnReady)
			.on("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer.start();
	}

	stop() {
		super.stop();

		this.vkWebSocketSignalServer
			.off("error", this.handleVkWebSocketSignalServerOnError)
			.off("started", this.handleVkWebSocketSignalServerOnStarted)
			.off("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.off("ready", this.handleVkWebSocketSignalServerOnReady)
			.off("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer.stop();
		this.vkWebSocketSignalServer = null;

		this.webSocketUrl = null;
	}

	handleVkWebSocketSignalServerOnError(error) {
		log("error", error);
	}

	handleVkWebSocketSignalServerOnStarted() {
		log("started");
	}

	handleVkWebSocketSignalServerOnStopped() {
		log("stopped");
	}

	async handleVkWebSocketSignalServerOnReady() {
		this.iceServers = [this.vkWebSocketSignalServer.connectionInfo.conversationParams.turn];

		await super.startConnection();

		if (this.turnServerConnectionSuccess) {
			log("peerId", this.vkWebSocketSignalServer.peerId);
			log("participantId", this.vkWebSocketSignalServer.participantId);
			log("conversationId", this.vkWebSocketSignalServer.conversationId);

			// кто зашёл вторым, т.е. в this.vkWebSocketSignalServer.connectionInfo.conversation.participants уже есть список участников
			// тот будет оффером, и будет отправлять существущему участнику заявку
			const firstParticipant = this.vkWebSocketSignalServer.connectionInfo.conversation.participants.at(0);
			if (firstParticipant) {
				this.isOfferPeer = true;
				this.offerParticipantId = this.vkWebSocketSignalServer.participantId;

				this.isAnswerPeer = false;
				this.answerParticipantId = firstParticipant.id;

				this.startOfferConnection();
			} else {
				this.isOfferPeer = false;
				this.offerParticipantId = null; // узнаем в notification === "custom-data"

				this.isAnswerPeer = true;
				this.answerParticipantId = firstParticipant.id;

				this.startAnswerConnection();
			}
		}
	}

	handleVkWebSocketSignalServerOnNotification(message) {
		if (this.isAnswerPeer &&
			message.notification === "custom-data") {
			const senderParticipantId = message.participantId;
			const data = message.data;
			const decryptedData = symmetricChipher.decrypt(data);
			if (decryptedData) {
				log("decryptedData", decryptedData, "from", senderParticipantId);

				this.offerParticipantId = senderParticipantId;
			}
		}
	}

	handleOnSdpOffer(sdpOffer) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId: this.answerParticipantId,
			data: symmetricChipher.encrypt(JSON.stringify(sdpOffer))
		});
	}

	handleOnSdpAnswer(sdpAnswer) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId: this.offerParticipantId,
			data: symmetricChipher.encrypt(JSON.stringify(sdpAnswer))
		});
	}
}
