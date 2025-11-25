import os from "node:os";

import chalk from "chalk";
import figlet from "figlet";
import parser from "yargs-parser";

import { log, setLogLevel, LOG_LEVELS } from "./utils/log.js";
import ntun from "./ntun.js";

import VkTransport from "./transport/vk-calls/VkTransport.js";

import info from "../package.json" with { type: "json" };

const argv = process.argv.slice(2);
// const argv = "TEST";

const args = parser(argv, {
	alias: { verbose: "v", input: "i", output: "o", transport: "t" },
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

const TRANSPORT = {
	TCP: "tcp",
	WEBSOCKET: "ws",
	VK_WEBRTC: "vk-webrtc",
	VK_CALLS: "vk-calls"
};

async function run() {
	printLogo();

	log(`NodeJS ${process.version}, OS ${os.version()}`);

	let logLevel = LOG_LEVELS.INFO;
	if (args.verbose === undefined) logLevel = LOG_LEVELS.INFO;
	else if (args.verbose === true) logLevel = LOG_LEVELS.INFO;
	else if (args.verbose === 0) logLevel = LOG_LEVELS.INFO;
	else if (args.verbose === 1) logLevel = LOG_LEVELS.DETAILED;
	else if (args.verbose >= 2) logLevel = LOG_LEVELS.DEBUG;
	else if (Array.isArray(args.verbose) &&
		args.verbose.every(Boolean)) {
		if (args.verbose.length === 1) logLevel = LOG_LEVELS.INFO;
		else if (args.verbose.length === 2) logLevel = LOG_LEVELS.DETAILED;
		else if (args.verbose.length >= 3) logLevel = LOG_LEVELS.DEBUG;
	} else throw new Error("Invalid verbose level");

	setLogLevel(logLevel);

	const node = new ntun.Node();

	if (!args.input && !args.output ||
		args.input && args.output) throw new Error("One of input or output must be specified");

	if (args.input) {
		if (!checkPort(args.input)) throw new Error("Invalid input port");

		node.connection = new ntun.inputConnections.Socks5InputConnection(node, { port: args.input });
	}

	if (args.output) {
		node.connection = new ntun.outputConnections.DirectOutputConnection(node);
	}

	if (!args.transport ||
		args.transport.length === 0) throw new Error("Transport must be specified");

	switch (args.transport[0]) {
		case TRANSPORT.TCP: {
			if (args.input) {
				try {
					let [host, port] = args.transport[1].split(":");
					port = Number(port);
					if (!checkPort(port)) throw new Error("Invalid transport port");

					node.transport = new ntun.transports.TCPBufferSocketClientTransport(host, port);
				} catch {
					throw new Error("Invalid transport URL");
				}
			} else if (args.output) {
				if (!checkPort(args.transport[1])) throw new Error("Invalid transport port");

				node.transport = new ntun.transports.TCPBufferSocketServerTransport(args.transport[1]);
			}

			break;
		}
		case TRANSPORT.WEBSOCKET: {
			if (args.input) {
				try {
					let [host, port] = args.transport[1].split(":");
					port = Number(port);
					if (!checkPort(port)) throw new Error("Invalid transport port");

					node.transport = new ntun.transports.WebSocketBufferSocketClientTransport(host, port);
				} catch {
					throw new Error("Invalid transport URL");
				}
			} else if (args.output) {
				if (!checkPort(args.transport[1])) throw new Error("Invalid transport port");

				node.transport = new ntun.transports.WebSocketBufferSocketServerTransport(args.transport[1]);
			}

			break;
		}
		case TRANSPORT.VK_WEBRTC: {
			let joinId;
			try {
				joinId = VkTransport.getJoinId(args.transport[1]);
			} catch {
				throw new Error("Invalid vk call joinId or join link");
			}

			if (args.input) {
				node.transport = new VkTransport.VkWebRTCTransport(joinId);
			} else if (args.output) {
				node.transport = new VkTransport.VkWebRTCTransport(joinId);
			}

			break;
		}
		case TRANSPORT.VK_CALLS: {
			let joinId;
			try {
				joinId = VkTransport.getJoinId(args.transport[1]);
			} catch {
				throw new Error("Invalid vk call joinId or join link");
			}

			if (args.input) {
				node.transport = new VkTransport.VkCallSignalServerTransport(joinId);
			} else if (args.output) {
				node.transport = new VkTransport.VkCallSignalServerTransport(joinId);
			}

			break;
		}

		default:
			throw new Error("Invalid transport");
	}

	node.start();
	node.transport.start();
}

run().catch(error => {
	log(chalk.red(error.message));

	return process.exit(1);
});
