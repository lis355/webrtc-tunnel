import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";
import { getVkWebSocketSignalServerUrlByJoinId, VkWebSocketSignalServer } from "./VkWebSocketSignalServer.js";
import { STATES, MESSAGE_TYPES } from "./constants.js";
import ntun from "../../ntun.js";
import symmetricBufferCipher from "../../utils/symmetricBufferCipher.js";
import WebRTCTransport from "../webrtc/WebRTCTransport.js";

// Транспорт, использующий TURN сервера VK
// Для получения TURN сервера и создания webrtc коннекта используется VkWebSocketSignalServer
export default class VkWebRTCTransport extends WebRTCTransport.WebRTCTransport {
	constructor(options) {
		super(options);

		this.joinId = this.options.joinId;

		this.handleVkWebSocketSignalServerOnError = this.handleVkWebSocketSignalServerOnError.bind(this);
		this.handleVkWebSocketSignalServerOnStarted = this.handleVkWebSocketSignalServerOnStarted.bind(this);
		this.handleVkWebSocketSignalServerOnStopped = this.handleVkWebSocketSignalServerOnStopped.bind(this);
		this.handleVkWebSocketSignalServerOnReady = this.handleVkWebSocketSignalServerOnReady.bind(this);
		this.handleVkWebSocketSignalServerOnMessage = this.handleVkWebSocketSignalServerOnMessage.bind(this);
		this.handleVkWebSocketSignalServerOnNotification = this.handleVkWebSocketSignalServerOnNotification.bind(this);
		this.handleOnSdpOffer = this.handleOnSdpOffer.bind(this);
		this.handleOnSdpAnswer = this.handleOnSdpAnswer.bind(this);

		this.on("sdp.offer", this.handleOnSdpOffer);
		this.on("sdp.answer", this.handleOnSdpAnswer);
	}

	createLog() {
		this.log = createLog("[transport]", "[vk-webrtc]");
	}

	startConnection() {
		this.startSignalServerConnection();
	}

	async startSignalServerConnection() {
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

		this.destroyTransportSocket();

		this.destroyPeer();

		if (this.vkWebSocketSignalServer) this.vkWebSocketSignalServer.stop();

		this.webSocketUrl = null;
	}

	handleVkWebSocketSignalServerOnError(error) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server error", error.message);
	}

	handleVkWebSocketSignalServerOnStarted() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server started");
	}

	handleVkWebSocketSignalServerOnStopped() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server stopped");

		this.vkWebSocketSignalServer
			.off("error", this.handleVkWebSocketSignalServerOnError)
			.off("started", this.handleVkWebSocketSignalServerOnStarted)
			.off("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.off("ready", this.handleVkWebSocketSignalServerOnReady)
			.off("message", this.handleVkWebSocketSignalServerOnMessage)
			.off("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer = null;

		if (this.workingState === ntun.WORKING_STATE.WORKING) this.stop();
	}

	async handleVkWebSocketSignalServerOnReady() {
		// DEBUG
		this.log = createLog("[transport]", "[vk-call]", this.vkWebSocketSignalServer.participantId);

		if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server participantId", this.vkWebSocketSignalServer.participantId, "conversationId", this.vkWebSocketSignalServer.conversationId);

		this.participants = {};

		this.vkWebSocketSignalServer.connectionInfo.conversation.participants
			.filter(participant => participant.id !== this.vkWebSocketSignalServer.participantId)
			.forEach(participant => { this.participants[participant.id] = participant; });

		this.iceServers = [this.vkWebSocketSignalServer.connectionInfo.conversationParams.turn];

		if (ifLog(LOG_LEVELS.DEBUG)) this.log("iceServers", JSON.stringify(this.iceServers));

		await super.startWebRTCConnection();

		if (this.turnServerConnectionSuccess) {
			this.setStateConnecting();
		}
	}

	sendConnectToOpponentParticipants() {
		Object.values(this.participants)
			.forEach(participant => {
				this.sendMessageToParticipant(participant.id, MESSAGE_TYPES.CONNECT);
			});
	}

	handleVkWebSocketSignalServerOnMessage(message) {
		// if (message.type === "notification" &&
		// 	["connection", "settings-update", "custom-data"].includes(message.notification) ||
		// 	message.type === "response") return;

		// this.log("handleVkWebSocketSignalServerOnMessage", message);
	}

	handleVkWebSocketSignalServerOnNotification(message) {
		switch (message.notification) {
			case "custom-data": {
				const senderParticipantId = message.participantId;
				try {
					const { type, ...data } = this.decodeParticipantMessageData(message.data);

					this.handleOnParticipantMessage(senderParticipantId, type, data);
				} catch (error) {
					if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic custom-data message from participant", senderParticipantId, "error", error.message);
				}

				break;
			}

			case "registered-peer": {
				if (message.participantType === "USER" &&
					message.platform === "WEB" &&
					message.clientType === "VK") {
					const participantId = message.participantId;

					this.participants[participantId] = { id: participantId };

					break;
				}
			}

			case "hungup": {
				const participantId = message.participantId;

				delete this.participants[participantId];

				if (this.state === STATES.CONNECTED &&
					participantId === this.opponentParticipantId) {
					this.setStateConnecting();
				}

				break;
			}
		}
	}

	handleOnParticipantMessage(participantId, type, data) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("handleOnParticipantMessage", this.vkWebSocketSignalServer.participantId, "<--", participantId, type);

		switch (this.state) {
			case STATES.CONNECTING: {
				switch (type) {
					case MESSAGE_TYPES.CONNECT: {
						if (!this.opponentParticipantId) {
							this.setStateConnected(participantId, { sendAccept: true });
						} else {
							if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, "message type", type, "state", this.state);
						}

						break;
					}
					case MESSAGE_TYPES.ACCEPT: {
						if (!this.opponentParticipantId) {
							this.setStateConnected(participantId, { sendAccept: false });
						} else {
							if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, "message type", type, "state", this.state);
						}

						break;
					}
					default: {
						if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, "message type", type, "state", this.state);
					}
				}

				break;
			}
			case STATES.CONNECTED: {
				switch (type) {
					case MESSAGE_TYPES.CONNECT: {
						if (ifLog(LOG_LEVELS.INFO)) this.log(participantId, "peer wants to connect, ignore (already connected)");

						// мы сами по себе не можем узнать, отсоединился ли пир, только по приходу нотифа hungup
						// который приходит, увы, где то через 30-80 секунд от сигнального сервера
						// альтернатива - делать свой пинг через turn server, но пока что это лишняя нагрузка
						// код для тестов, если есть только 2 пира, чтобы не ждать
						// setTimeout(() => this.setStateConnecting(), 1000);

						break;
					}
					case MESSAGE_TYPES.ACCEPT: {
						if (participantId !== this.opponentParticipantId) {
							if (ifLog(LOG_LEVELS.INFO)) this.log(participantId, "peer wants to accept, ignore (already connected)");
						}

						break;
					}
					case MESSAGE_TYPES.SDP_OFFER: {
						if (this.isAnswerPeer &&
							this.offerParticipantId === participantId) {
							this.createAnswer(data.sdp);
						} else {
							if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, "message type", type, "state", this.state);
						}

						break;
					}
					case MESSAGE_TYPES.SDP_ANSWER: {
						if (this.isOfferPeer &&
							this.answerParticipantId === participantId) {
							this.setAnswer(data.sdp);
						} else {
							if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, "message type", type, "state", this.state);
						}

						break;
					}
					case MESSAGE_TYPES.BUFFER: {
						this.transportSocket.push(Buffer.from(data.buffer, "base64"));

						break;
					}
					default: {
						if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, "message type", type, "state", this.state);
					}
				}

				break;
			}
		}
	}

	setStateConnecting() {
		this.state = STATES.CONNECTING;

		this.opponentParticipantId = null;

		this.destroyTransportSocket();

		this.sendConnectToOpponentParticipants();
	}

	setStateConnected(participantId, { sendAccept }) {
		this.state = STATES.CONNECTED;

		this.opponentParticipantId = participantId;

		if (sendAccept) {
			this.sendMessageToParticipant(this.opponentParticipantId, MESSAGE_TYPES.ACCEPT);

			this.isOfferPeer = true;
			this.offerParticipantId = this.vkWebSocketSignalServer.participantId;

			this.isAnswerPeer = false;
			this.answerParticipantId = this.opponentParticipantId;

			if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server start offer connection", "answerParticipantId", this.answerParticipantId);

			this.startOfferConnection();
		} else {
			this.isOfferPeer = false;
			this.offerParticipantId = this.opponentParticipantId;

			this.isAnswerPeer = true;
			this.answerParticipantId = this.vkWebSocketSignalServer.participantId;

			if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server start answer connection");

			this.startAnswerConnection();
		}
	}

	sendMessageToParticipant(participantId, type, data = {}) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("sendMessageToParticipant", this.vkWebSocketSignalServer.participantId, "-->", participantId, type);

		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId,
			data: this.encodeParticipantMessageData(type, data)
		});
	}

	encodeParticipantMessageData(type, data = {}) {
		return symmetricBufferCipher.encrypt(Buffer.from(JSON.stringify({ type, ...data }))).toString("base64");
	}

	decodeParticipantMessageData(data) {
		return JSON.parse(symmetricBufferCipher.decrypt(Buffer.from(data, "base64")).toString());
	}

	handleOnSdpOffer(sdpOffer) {
		this.sendMessageToParticipant(this.opponentParticipantId, MESSAGE_TYPES.SDP_OFFER, { sdp: sdpOffer });
	}

	handleOnSdpAnswer(sdpAnswer) {
		this.sendMessageToParticipant(this.opponentParticipantId, MESSAGE_TYPES.SDP_ANSWER, { sdp: sdpAnswer });
	}
}
