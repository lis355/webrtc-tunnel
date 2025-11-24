import crypto from "node:crypto";
import EventEmitter from "events";

import * as ws from "ws";

import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";

const log = createLog("[VkWebSocketSignalServer]");

export async function getVkWebSocketSignalServerUrlByJoinId(joinId) {
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

		// log("POST", url);
		// log(JSON.stringify(params, null, 2));
		// log(JSON.stringify(json, null, 2));

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

export class VkWebSocketSignalServer extends EventEmitter {
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
			.off("message", this.handleWebSocketOnMessage);

		this.webSocket.close();
	}

	handleWebSocketOnError(error) {
		this.emit("error", error);
	}

	handleWebSocketOnOpen() {
		this.emit("started");
	}

	handleWebSocketOnClose() {
		this.webSocket
			.off("error", this.handleWebSocketOnError)
			.off("open", this.handleWebSocketOnOpen)
			.off("close", this.handleWebSocketOnClose)
			.off("message", this.handleWebSocketOnMessage);

		this.webSocket = null;

		this.emit("stopped");
	}

	handleWebSocketOnMessage(data) {
		try {
			data = data.toString();
		} catch {
			if (ifLog(LOG_LEVELS.DETAILED)) log("recieve unknown message");

			return;
		}

		let json;
		try {
			json = JSON.parse(data);
		} catch {
		}

		// if (ifLog(LOG_LEVELS.DEBUG)) log("VkWebSocketSignalServer", "recieve", data);

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
