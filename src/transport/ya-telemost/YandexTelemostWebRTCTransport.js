import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";
import { getYandexTelemostWebSocketSignalServerInfoByJoinId, YandexTelemostWebSocketSignalServer } from "./YandexTelemostWebSocketSignalServer.js";
import { STATES, MESSAGE_TYPES } from "./constants.js";
import getJoinId from "./getJoinId.js";
import ntun from "../../ntun.js";
import symmetricBufferCipher from "../../utils/symmetricBufferCipher.js";
import WebRTCTransport from "../webrtc/WebRTCTransport.js";

// Транспорт, использующий TURN сервера
// Для получения TURN сервера и создания webrtc коннекта используется WebSocketSignalServer
export class YandexTelemostWebRTCTransport extends WebRTCTransport.WebRTCTransport {
	constructor(options) {
		super(options);

		this.joinId = this.options.joinId;

		this.handleSignalServerOnError = this.handleSignalServerOnError.bind(this);
		this.handleSignalServerOnStarted = this.handleSignalServerOnStarted.bind(this);
		this.handleSignalServerOnStopped = this.handleSignalServerOnStopped.bind(this);
		this.handleSignalServerOnReady = this.handleSignalServerOnReady.bind(this);
		this.handleSignalServerOnMessage = this.handleSignalServerOnMessage.bind(this);
		this.handleSignalServerOnNotification = this.handleSignalServerOnNotification.bind(this);
		this.handleOnSdpOffer = this.handleOnSdpOffer.bind(this);
		this.handleOnSdpAnswer = this.handleOnSdpAnswer.bind(this);

		this.on("sdp.offer", this.handleOnSdpOffer);
		this.on("sdp.answer", this.handleOnSdpAnswer);
	}

	createLog() {
		this.log = createLog("[transport]", "[ya-telemost-webrtc]");
	}

	startConnection() {
		this.startSignalServerConnection();
	}

	async startSignalServerConnection() {
		this.signalServerInfo = await getYandexTelemostWebSocketSignalServerInfoByJoinId(this.joinId);

		this.signalServer = new YandexTelemostWebSocketSignalServer(this.signalServerInfo);
		this.signalServer
			.on("error", this.handleSignalServerOnError)
			.on("started", this.handleSignalServerOnStarted)
			.on("stopped", this.handleSignalServerOnStopped)
			.on("ready", this.handleSignalServerOnReady)
			.on("message", this.handleSignalServerOnMessage)
			.on("notification", this.handleSignalServerOnNotification);

		this.signalServer.start();
	}

	stop() {
		super.stop();

		this.destroyTransportSocket();

		this.destroyPeer();

		if (this.signalServer) this.signalServer.stop();

		this.signalServerInfo = null;
	}

	handleSignalServerOnError(error) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("ya signal server error", error.message);
	}

	handleSignalServerOnStarted() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("ya signal server started");
	}

	handleSignalServerOnStopped() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("ya signal server stopped");

		this.signalServer
			.off("error", this.handleSignalServerOnError)
			.off("started", this.handleSignalServerOnStarted)
			.off("stopped", this.handleSignalServerOnStopped)
			.off("ready", this.handleSignalServerOnReady)
			.off("message", this.handleSignalServerOnMessage)
			.off("notification", this.handleSignalServerOnNotification);

		this.signalServer = null;

		if (this.workingState === ntun.WORKING_STATE.WORKING) this.stop();
	}

	async handleSignalServerOnReady() {
		// this.log = createLog("[transport]", "[vk-call]", this.vkWebSocketSignalServer.participantId);

		if (ifLog(LOG_LEVELS.INFO)) this.log("ya signal server participantId", this.signalServer.participantId, "roomId", this.signalServer.roomId);

		this.iceServers = this.signalServer.serverHello.rtcConfiguration.iceServers.filter(iceServer => iceServer.urls.every(url => url.startsWith("turn")));

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

	handleSignalServerOnMessage(message) {
		if (message.updateDescription) return;

		if (message.subscriberSdpOffer) {
			delete message.subscriberSdpOffer.sdp;

			console.log(JSON.stringify(message, null, 4));
		} else if (message.subscriberSdpAnswer) {
			delete message.subscriberSdpAnswer.sdp;

			console.log(JSON.stringify(message, null, 4));
		} else if (message.publisherSdpAnswer) {
			delete message.publisherSdpAnswer.sdp;

			console.log(JSON.stringify(message, null, 4));
		} else if (message.upsertDescription ||
			message.removeDescription) {
			console.log(Object.keys(message));
		} else {
			console.log(Object.keys(message));
		}
	}

	handleSignalServerOnNotification(message) {
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
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("handleOnParticipantMessage", this.signalServer.participantId, "<--", participantId, type);

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

		// this.sendConnectToOpponentParticipants();

		this.isOfferPeer = true;
		this.offerParticipantId = this.signalServer.participantId;

		this.isAnswerPeer = false;
		this.answerParticipantId = null;

		this.startOfferConnection();
	}

	setStateConnected(participantId, { sendAccept }) {
		this.state = STATES.CONNECTED;

		this.opponentParticipantId = participantId;

		if (sendAccept) {
			this.sendMessageToParticipant(this.opponentParticipantId, MESSAGE_TYPES.ACCEPT);

			this.isOfferPeer = true;
			this.offerParticipantId = this.signalServer.participantId;

			this.isAnswerPeer = false;
			this.answerParticipantId = this.opponentParticipantId;

			if (ifLog(LOG_LEVELS.INFO)) this.log("ya signal server start offer connection", "answerParticipantId", this.answerParticipantId);

			this.startOfferConnection();
		} else {
			this.isOfferPeer = false;
			this.offerParticipantId = this.opponentParticipantId;

			this.isAnswerPeer = true;
			this.answerParticipantId = this.signalServer.participantId;

			if (ifLog(LOG_LEVELS.INFO)) this.log("ya signal server start answer connection");

			this.startAnswerConnection();
		}
	}

	sendMessageToParticipant(participantId, type, data = {}) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("sendMessageToParticipant", this.signalServer.participantId, "-->", participantId, type);

		this.signalServer.sendCommand("custom-data", {
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
		this.signalServer.sendRequest({
			publisherSdpOffer: {
				pcSeq: 1,
				sdp: sdpOffer.sdp,
				tracks: []
			}
		});

		// this.sendMessageToParticipant(this.opponentParticipantId, MESSAGE_TYPES.SDP_OFFER, { sdp: sdpOffer });
	}

	handleOnSdpAnswer(sdpAnswer) {
		this.sendMessageToParticipant(this.opponentParticipantId, MESSAGE_TYPES.SDP_ANSWER, { sdp: sdpAnswer });
	}
}

export default {
	getJoinId,
	YandexTelemostWebRTCTransport
};
