import figlet from "figlet";
import parser from "yargs-parser";

import { WebRTCPeerServerTransport, WebRTCPeerClientTransport } from "./transport/webrtc/WebRTCTransport.js";
import getJoinId from "./transport/vk-calls/getJoinId.js";
import log from "./utils/log.js";
import ntun from "./ntun.js";
import VkCallSignalServerTransport from "./transport/vk-calls/VkCallSignalServerTransport.js";
import VkWebRTCTransport from "./transport/vk-calls/VkWebRTCTransport.js";

import info from "../package.json" with { type: "json" };

// const argv = process.argv.slice(2);
// const argv = "TEST";
const argv = "node ./src/ntun.cli.js -o -t vk-calls \"https://vk.com/call/join/KN7WkCCyjKwlRaj-w8WIzr4SfM3WxuJvQY-auqYv5rQ\"";

const args = parser(argv, {
	alias: { input: "i", output: "o", transport: "t" },
	array: ["transport"]
});

function printLogo() {
	process.stdout.write(
		figlet.textSync(`${info.name} ${info.version}`, {
			font: "ANSI Shadow",
			whitespaceBreak: false
		}).trim() + "\n"
	);
}

function checkPort(port) {
	return Number.isFinite(port) &&
		port >= 0 &&
		port <= 65535;
}

async function run() {
	printLogo();

	const node = new ntun.Node();

	if (!args.input && !args.output ||
		args.input && args.output) throw new Error("One of input or output must be specified");

	if (args.input) {
		if (!checkPort(args.input)) throw new Error("Invalid input port");

		node.inputConnection = new ntun.inputConnections.Socks5InputConnection(node, { port: args.input });

		log("Input connection", node.inputConnection.constructor.name, "created");
	}

	if (args.output) {
		node.outputConnection = new ntun.outputConnections.InternetOutputConnection(node);

		log("Output connection", node.outputConnection.constructor.name, "created");
	}

	if (!args.transport ||
		args.transport.length === 0) throw new Error("Transport must be specified");

	switch (args.transport[0]) {
		case "tcp": {
			if (node.inputConnection) {
				try {
					let [host, port] = args.transport[1].split(":");
					port = Number(port);
					if (!checkPort(port)) throw new Error("Invalid transport port");

					node.transport = new ntun.transports.TCPBufferSocketClientTransport(host, port);
				} catch {
					throw new Error("Invalid transport URL");
				}
			} else if (node.outputConnection) {
				if (!checkPort(args.transport[1])) throw new Error("Invalid transport port");

				node.transport = new ntun.transports.TCPBufferSocketServerTransport(args.transport[1]);
			}

			break;
		}
		case "ws": {
			if (node.inputConnection) {
				try {
					let [host, port] = args.transport[1].split(":");
					port = Number(port);
					if (!checkPort(port)) throw new Error("Invalid transport port");

					node.transport = new ntun.transports.WebSocketBufferSocketClientTransport(host, port);
				} catch {
					throw new Error("Invalid transport URL");
				}
			} else if (node.outputConnection) {
				if (!checkPort(args.transport[1])) throw new Error("Invalid transport port");

				node.transport = new ntun.transports.WebSocketBufferSocketServerTransport(args.transport[1]);
			}

			break;
		}
		case "webrtc": {
			let iceServers;
			try {
				iceServers = JSON.parse(args.transport[1]);
			} catch {
				throw new Error("Invalid ice servers json");
			}

			if (node.inputConnection) {
				node.transport = new WebRTCPeerClientTransport(iceServers);
			} else if (node.outputConnection) {
				node.transport = new WebRTCPeerServerTransport(iceServers);
			}

			break;
		}
		case "vk-webrtc": {
			let joinId;
			try {
				joinId = getJoinId(args.transport[1]);
			} catch {
				throw new Error("Invalid vk call joinId or join link");
			}

			if (node.inputConnection) {
				node.transport = new VkWebRTCTransport(joinId);
			} else if (node.outputConnection) {
				node.transport = new VkWebRTCTransport(joinId);
			}

			break;
		}
		case "vk-calls": {
			let joinId;
			try {
				joinId = getJoinId(args.transport[1]);
			} catch {
				throw new Error("Invalid vk call joinId or join link");
			}

			if (node.inputConnection) {
				node.transport = new VkCallSignalServerTransport(joinId);
			} else if (node.outputConnection) {
				node.transport = new VkCallSignalServerTransport(joinId);
			}

			break;
		}

		default:
			throw new Error("Invalid transport");
	}

	log("Transport", node.transport.constructor.name, "created");

	node.transport
		.on("connected", () => {
			log("Transport", node.transport.constructor.name, "connected");

			node.start();
		})
		.on("closed", () => {
			log("Transport", node.transport.constructor.name, "closed");

			node.stop();
		});

	node.transport.start();
}

run();
