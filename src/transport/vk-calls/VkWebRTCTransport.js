import { getVkWebSocketSignalServerUrlByJoinId, VkWebSocketSignalServer } from "./VkWebSocketSignalServer.js";
import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";
import WebRTCTransport from "../webrtc/WebRTCTransport.js";

// Транспорт, использующий TURN сервера VK
// Для получения TURN сервера и создания webrtc коннекта используется VkWebSocketSignalServer
export default class VkWebRTCTransport extends WebRTCTransport.WebRTCTransport {
	constructor(joinId) {
		super();

		this.joinId = joinId;

		this.handleOnSdpOffer = this.handleOnSdpOffer.bind(this);
		this.handleOnSdpAnswer = this.handleOnSdpAnswer.bind(this);
		this.handleVkWebSocketSignalServerOnError = this.handleVkWebSocketSignalServerOnError.bind(this);
		this.handleVkWebSocketSignalServerOnStarted = this.handleVkWebSocketSignalServerOnStarted.bind(this);
		this.handleVkWebSocketSignalServerOnStopped = this.handleVkWebSocketSignalServerOnStopped.bind(this);
		this.handleVkWebSocketSignalServerOnReady = this.handleVkWebSocketSignalServerOnReady.bind(this);
		this.handleVkWebSocketSignalServerOnMessage = this.handleVkWebSocketSignalServerOnMessage.bind(this);
		this.handleVkWebSocketSignalServerOnNotification = this.handleVkWebSocketSignalServerOnNotification.bind(this);

		this.on("sdp.offer", this.handleOnSdpOffer);
		this.on("sdp.answer", this.handleOnSdpAnswer);
	}

	createLog() {
		this.log = createLog("[transport]", "[vk-webrtc]");
	}

	async startConnection() {
		this.webSocketUrl = await getVkWebSocketSignalServerUrlByJoinId(this.joinId);

		this.vkWebSocketSignalServer = new VkWebSocketSignalServer(this.webSocketUrl);
		this.vkWebSocketSignalServer
			.on("error", this.handleVkWebSocketSignalServerOnError)
			.on("started", this.handleVkWebSocketSignalServerOnStarted)
			.on("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.on("ready", this.handleVkWebSocketSignalServerOnReady)
			.on("message", this.handleVkWebSocketSignalServerOnMessage)
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
			.off("message", this.handleVkWebSocketSignalServerOnMessage)
			.off("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer.stop();
		this.vkWebSocketSignalServer = null;

		this.webSocketUrl = null;
	}

	handleVkWebSocketSignalServerOnError(error) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server error", error.message);
	}

	handleVkWebSocketSignalServerOnStarted() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server started");

		this.emitStarted();
	}

	handleVkWebSocketSignalServerOnStopped() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server stopped");

		this.emitStopped();
	}

	async handleVkWebSocketSignalServerOnReady() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server got connection");

		this.iceServers = [this.vkWebSocketSignalServer.connectionInfo.conversationParams.turn];

		if (ifLog(LOG_LEVELS.DEBUG)) this.log("iceServers", JSON.stringify(this.iceServers));

		await super.startConnection();

		if (this.turnServerConnectionSuccess) {
			if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server peerId", this.vkWebSocketSignalServer.peerId, "participantId", this.vkWebSocketSignalServer.participantId, "conversationId", this.vkWebSocketSignalServer.conversationId);

			// кто зашёл вторым, т.е. в this.vkWebSocketSignalServer.connectionInfo.conversation.participants уже есть список участников
			// тот будет оффером, и будет отправлять существущему участнику заявку
			const firstParticipant = this.vkWebSocketSignalServer.connectionInfo.conversation.participants
				.filter(participant => participant.id !== this.vkWebSocketSignalServer.participantId)
				.at(0);

			if (firstParticipant) {
				this.isOfferPeer = true;
				this.offerParticipantId = this.vkWebSocketSignalServer.participantId;

				this.isAnswerPeer = false;
				this.answerParticipantId = firstParticipant.id;

				if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server start offer connection", "answerParticipantId", this.answerParticipantId);

				this.startOfferConnection();
			} else {
				this.isOfferPeer = false;
				this.offerParticipantId = null; // узнаем в notification === "custom-data"

				this.isAnswerPeer = true;
				this.answerParticipantId = this.vkWebSocketSignalServer.participantId;

				if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server start answer connection");

				this.startAnswerConnection();
			}
		}
	}

	handleVkWebSocketSignalServerOnMessage(message) {
		// if (message &&
		// 	message.type === "notification" &&
		// 	["connection", "settings-update"].includes(message.notification)) return;

		// if (ifLog(LOG_LEVELS.DEBUG)) this.log("vk signal server", "handleVkWebSocketSignalServerOnMessage", message);
	}

	handleVkWebSocketSignalServerOnNotification(message) {
		if (message.notification === "custom-data") {
			const senderParticipantId = message.participantId;
			const data = message.data;

			const decryptedData = symmetricStringCipher.decrypt(data);
			if (decryptedData) {
				let sdp;
				try {
					sdp = JSON.parse(decryptedData);
				} catch {
					if (ifLog(LOG_LEVELS.INFO)) this.log("bad data decoding from participant", senderParticipantId, "data", data);
				}

				if (sdp) {
					if (ifLog(LOG_LEVELS.INFO)) this.log("sdp", sdp.type, "from", senderParticipantId);

					if (this.isOfferPeer &&
						this.answerParticipantId === senderParticipantId) {
						this.setAnswer(sdp);
					} else if (this.isAnswerPeer) {
						this.offerParticipantId = senderParticipantId;

						this.createAnswer(sdp);
					} else {
						if (ifLog(LOG_LEVELS.INFO)) this.log("strange logic on decoded sdp message from participant", senderParticipantId, "data", data);
					}
				} else {
					if (ifLog(LOG_LEVELS.INFO)) this.log("unknown custom-data message from participant", senderParticipantId, "data", data);
				}
			} else {
				if (ifLog(LOG_LEVELS.INFO)) this.log("unknown custom-data message from participant", senderParticipantId, "data", data);
			}
		}
	}

	handleOnSdpOffer(sdpOffer) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId: this.answerParticipantId,
			data: symmetricStringCipher.encrypt(JSON.stringify(sdpOffer))
		});
	}

	handleOnSdpAnswer(sdpAnswer) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId: this.offerParticipantId,
			data: symmetricStringCipher.encrypt(JSON.stringify(sdpAnswer))
		});
	}
}
