import figlet from "figlet";
import parser from "yargs-parser";

import { WebRTCPeerServerTransport, WebRTCPeerClientTransport } from "./transports/WebRTCPeerServerTransport.js";
import log from "./utils/log.js";
import ntun from "./ntun.js";
import vk from "./vk.js";

import info from "./package.json" with { type: "json" };

const argv = process.argv.slice(2);
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
				} catch (_) {
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
				} catch (_) {
					throw new Error("Invalid transport URL");
				}
			} else if (node.outputConnection) {
				if (!checkPort(args.transport[1])) throw new Error("Invalid transport port");

				node.transport = new ntun.transports.WebSocketBufferSocketServerTransport(args.transport[1]);
			}

			break;
		}
		case "vk-webrtc": {
			let joinId;
			try {
				joinId = vk.getJoinId(args.transport[1]);
			} catch (_) {
				throw new Error("Invalid vk call joinId or join link");
			}

			if (node.inputConnection) {
				node.transport = new WebRTCPeerClientTransport(joinId);
			} else if (node.outputConnection) {
				node.transport = new WebRTCPeerServerTransport(joinId);
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
