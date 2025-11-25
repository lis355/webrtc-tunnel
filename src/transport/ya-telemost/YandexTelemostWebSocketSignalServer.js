import crypto from "node:crypto";
import EventEmitter from "events";

import * as ws from "ws";

import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";

const log = createLog("[YandexTelemostWebSocketSignalServer]");

export async function getYandexTelemostWebSocketSignalServerInfoByJoinId(joinId) {
	const clientInstanceId = crypto.randomUUID();
	const username = "anon_" + clientInstanceId.slice(0, 4);

	try {
		const response = await fetch(`https://cloud-api.yandex.ru/telemost_front/v2/telemost/conferences/https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F${joinId}/connection?next_gen_media_platform_allowed=true&display_name=${username}&waiting_room_supported=true`, {
			"headers": {
				"client-instance-id": clientInstanceId,
				"Referer": "https://telemost.yandex.ru/"
			},
			"body": null,
			"method": "GET"
		});

		const json = await response.json();

		switch (json.error) {
			case "ConferenceNotFound":
				throw new Error("Conference not found");
			default:
				if (json.error) throw new Error(json.error);
		}

		if (!json ||
			!json.credentials ||
			!json["client_configuration"]["media_server_url"]) throw new Error("No info in response");

		return json;
	} catch (error) {
		throw new Error(`Failed to get Yandex Telemost WebSocket signal server info by joinId (${error.message})`);
	}
}

export class YandexTelemostWebSocketSignalServer extends EventEmitter {
	static PING_TIMEOUT = 5000;

	constructor(info) {
		super();

		this.info = info;
		this.webSocketUrl = new URL(this.info["client_configuration"]["media_server_url"]);
		this.participantId = this.info["peer_id"];
		this.roomId = this.info["room_id"];

		this.handleWebSocketOnError = this.handleWebSocketOnError.bind(this);
		this.handleWebSocketOnOpen = this.handleWebSocketOnOpen.bind(this);
		this.handleWebSocketOnClose = this.handleWebSocketOnClose.bind(this);
		this.handleWebSocketOnMessage = this.handleWebSocketOnMessage.bind(this);
		this.sendPing = this.sendPing.bind(this);
	}

	start() {
		this.webSocket = new ws.WebSocket(this.webSocketUrl.href);
		this.webSocket
			.on("error", this.handleWebSocketOnError)
			.on("open", this.handleWebSocketOnOpen)
			.on("close", this.handleWebSocketOnClose)
			.on("message", this.handleWebSocketOnMessage);
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

		this.pingTimeout = setTimeout(this.sendPing, YandexTelemostWebSocketSignalServer.PING_TIMEOUT);

		this.sendHello();
	}

	handleWebSocketOnClose() {
		this.pingTimeout = clearTimeout(this.pingTimeout);

		this.webSocket
			.off("error", this.handleWebSocketOnError)
			.off("open", this.handleWebSocketOnOpen)
			.off("close", this.handleWebSocketOnClose)
			.off("message", this.handleWebSocketOnMessage);

		this.webSocket = null;

		this.emit("stopped");
	}

	handleWebSocketOnMessage(data) {
		let json, uid;
		try {
			data = data.toString();
			json = JSON.parse(data);
			uid = json.uid;
		} catch {
			if (ifLog(LOG_LEVELS.DETAILED)) log("recieve unknown message");

			return;
		}

		// if (ifLog(LOG_LEVELS.DEBUG)) log("VkWebSocketSignalServer", "recieve", data);

		if (!json.ack) {
			this.answerOk(uid);

			if (json.serverHello) {
				this.serverHello = json.serverHello;

				this.emit("ready");
			} else {
				this.emit("message", json);
			}
		}
	}

	sendMessage(uid, message) {
		this.pingTimeout = clearTimeout(this.pingTimeout);
		this.pingTimeout = setTimeout(this.sendPing, YandexTelemostWebSocketSignalServer.PING_TIMEOUT);

		const str = JSON.stringify({ uid, ...message });
		this.webSocket.send(str);
	}

	sendRequest(data) {
		this.sendMessage(crypto.randomUUID(), data);
	}

	answerOk(messageUid) {
		this.sendMessage(messageUid, {
			ack: { status: { code: "OK" } }
		});
	}

	sendPing() {
		this.sendMessage(crypto.randomUUID(), { ping: {} });
	}

	sendHello() {
		this.sendRequest({
			hello: {
				"participantMeta": {
					"name": "super",
					"role": "SPEAKER",
					"description": "",
					"sendAudio": false,
					"sendVideo": false
				},
				"participantAttributes": {
					"name": "super",
					"role": "SPEAKER",
					"description": ""
				},
				"sendAudio": false,
				"sendVideo": false,
				"sendSharing": false,
				"participantId": this.participantId,
				"roomId": this.roomId,
				"serviceName": "telemost",
				"credentials": this.info.credentials,
				"capabilitiesOffer": {
					"offerAnswerMode": [
						"SEPARATE"
					],
					"initialSubscriberOffer": [
						"ON_HELLO"
					],
					"slotsMode": [
						"FROM_CONTROLLER"
					],
					"simulcastMode": [
						"DISABLED",
						"STATIC"
					],
					"selfVadStatus": [
						"FROM_SERVER",
						"FROM_CLIENT"
					],
					"dataChannelSharing": [
						"TO_RTP"
					],
					"videoEncoderConfig": [
						"NO_CONFIG",
						"ONLY_INIT_CONFIG",
						"RUNTIME_CONFIG"
					],
					"dataChannelVideoCodec": [
						"VP8",
						"UNIQUE_CODEC_FROM_TRACK_DESCRIPTION"
					],
					"bandwidthLimitationReason": [
						"BANDWIDTH_REASON_DISABLED",
						"BANDWIDTH_REASON_ENABLED"
					],
					"sdkDefaultDeviceManagement": [
						"SDK_DEFAULT_DEVICE_MANAGEMENT_DISABLED",
						"SDK_DEFAULT_DEVICE_MANAGEMENT_ENABLED"
					],
					"joinOrderLayout": [
						"JOIN_ORDER_LAYOUT_DISABLED",
						"JOIN_ORDER_LAYOUT_ENABLED"
					],
					"pinLayout": [
						"PIN_LAYOUT_DISABLED"
					],
					"sendSelfViewVideoSlot": [
						"SEND_SELF_VIEW_VIDEO_SLOT_DISABLED",
						"SEND_SELF_VIEW_VIDEO_SLOT_ENABLED"
					],
					"serverLayoutTransition": [
						"SERVER_LAYOUT_TRANSITION_DISABLED"
					],
					"sdkPublisherOptimizeBitrate": [
						"SDK_PUBLISHER_OPTIMIZE_BITRATE_DISABLED",
						"SDK_PUBLISHER_OPTIMIZE_BITRATE_FULL",
						"SDK_PUBLISHER_OPTIMIZE_BITRATE_ONLY_SELF"
					],
					"sdkNetworkLostDetection": [
						"SDK_NETWORK_LOST_DETECTION_DISABLED"
					],
					"sdkNetworkPathMonitor": [
						"SDK_NETWORK_PATH_MONITOR_DISABLED"
					],
					"publisherVp9": [
						"PUBLISH_VP9_DISABLED",
						"PUBLISH_VP9_ENABLED"
					],
					"svcMode": [
						"SVC_MODE_DISABLED",
						"SVC_MODE_L3T3",
						"SVC_MODE_L3T3_KEY"
					],
					"subscriberOfferAsyncAck": [
						"SUBSCRIBER_OFFER_ASYNC_ACK_DISABLED",
						"SUBSCRIBER_OFFER_ASYNC_ACK_ENABLED"
					],
					"svcModes": [
						"FALSE"
					],
					"reportTelemetryModes": [
						"TRUE"
					],
					"keepDefaultDevicesModes": [
						"TRUE"
					]
				},
				"sdkInfo": {
					"implementation": "browser",
					"version": "5.15.0",
					"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
					"hwConcurrency": 8
				},
				"sdkInitializationId": crypto.randomUUID(),
				"disablePublisher": false,
				"disableSubscriber": false,
				"disableSubscriberAudio": false
			}
		});
	}
}
