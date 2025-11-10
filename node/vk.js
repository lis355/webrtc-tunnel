import crypto from "node:crypto";
import EventEmitter from "node:events";

import { config as dotenv } from "dotenv-flow";
import * as ws from "ws";
import parser from "yargs-parser";

import log from "./utils/log.js";

dotenv();

const argv = process.argv.slice(2);
const args = parser(argv, {
	alias: { input: "i", output: "o", transport: "t" },
	array: ["transport"]
});

const isDevelopment = Boolean(process.env.VSCODE_INJECTION &&
	process.env.VSCODE_INSPECTOR_OPTIONS);

function getJoinId(joinIdOrLink) {
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
	static MESSAGE_TYPES = {
		RESPONSE: "response",
		NOTIFICATION: "notification"
	};

	constructor(webSocketUrl) {
		super();

		this.webSocketUrl = webSocketUrl;
	}

	start() {
		this.webSocket = new ws.WebSocket(this.webSocketUrl);
		this.webSocket
			.on("open", () => {
				this.emit("started");
			})
			.on("close", () => {
				this.emit("stopped");
			})
			.on("error", error => {
				this.emit("error", error);
			})
			.on("message", data => {
				try {
					data = data.toString();
				} catch (_) {
					log("VkWebSocketSignalServer", "unknown message");

					return;
				}

				let json;
				try {
					json = JSON.parse(data);
				} catch (_) {
				}

				log("VkWebSocketSignalServer", "message", data);

				let unknown;
				if (json) {
					if (json.type === "response") this.emit("message-response", json);
					else if (json.type === "notification") {
						if (json.conversationParams &&
							json.conversationParams.turn) this.emit("message-servers", [json.conversationParams.turn]);
						else if (json.notification === "participant-joined") this.emit("message-participant-joined", json.participant);
						else if (json.notification === "hungup") this.emit("message-participant-left", json.participantId);
						else unknown = true;
					} else if (json.type === "error") {
						if (json.error === "conversation-ended") this.emit("message-conversation-ended");
						else unknown = true;
					}
				} else if (typeof data === "string") {
					if (data === "ping") this.webSocket.send("pong");
					else unknown = true;
				}

				if (unknown) log("VkWebSocketSignalServer", "unknown message", data);
			});
	}

	stop() {
		this.webSocket.close();
		this.webSocket = null;
	}
}

export default {
	getJoinId,
	getVkWebSocketSignalServerUrlByJoinId,
	VkWebSocketSignalServer
};

async function run() {
	let joinIdOrLink;
	if (isDevelopment) {
		joinIdOrLink = process.env.DEVELOP_VK_JOIN_ID_OR_LINK;
	} else {
		if (args._.length < 1) throw new Error("Please provide a join id or link");

		joinIdOrLink = args._[0];
	}

	const joinId = getJoinId(joinIdOrLink);
	log("joinId", joinId);

	const webSocketUrl = await getVkWebSocketSignalServerUrlByJoinId(joinId);
	log("webSocketUrl", webSocketUrl);

	const vkWebSocketSignalServer = new VkWebSocketSignalServer(webSocketUrl);
	vkWebSocketSignalServer
		.on("message-conversation-ended", () => {
			log("conversation-ended");
		})
		.on("message-servers", servers => {
			log("iceServers", JSON.stringify(servers));
		})
		.on("message-participant-joined", participant => {
			log(participant);
		})
		.on("message-participant-left", participantId => {
			log(participantId);
		});

	vkWebSocketSignalServer.start();
}

run();	
