import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";
import figlet from "figlet";
import parser from "yargs-parser";
import YAML from "yaml";

import { log, setLogLevel, LOG_LEVELS } from "./utils/log.js";
import { parseTransferRate } from "./utils/DataRateLimiter.js";
import ntun from "./ntun.js";

import VkTransport from "./transport/vk-calls/VkTransport.js";

import info from "../package.json" with { type: "json" };

const argv = process.argv.slice(2);

const args = parser(argv, {
	alias: { verbose: "v", config: "c" }
});

function printLogo() {
	process.stdout.write(
		figlet.textSync(`${info.name} ${info.version}`, {
			font: "ANSI Shadow",
			whitespaceBreak: false
		}).trim() + "\n"
	);
}

function checkHost(host) {
	return typeof host === "string" &&
		host.length > 0 &&
		/^[a-zA-Z0-9.-]+$/.test(host);
}

function checkPort(port) {
	return Number.isFinite(port) &&
		port >= 0 &&
		port <= 65535;
}

const INPUT_TYPES = {
	SOCKS5: "socks5"
};

const OUTPUT_TYPES = {
	DIRECT: "direct"
};

const TRANSPORT = {
	TCP: "tcp",
	WEBSOCKET: "ws",
	VK_CALLS: "vk-calls",
	VK_WEBRTC: "vk-webrtc"
};

function processLogLevel() {
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
}

let config;

function processConfig() {
	const configPath = path.resolve(args.config || args._[0] || "config.yaml");
	if (!fs.existsSync(configPath)) throw new Error(`Config not found at ${configPath}`);

	try {
		config = YAML.parse(fs.readFileSync(configPath).toString());
	} catch (error) {
		throw new Error(`Error in parsing config file at ${configPath} (${error.message})`);
	}
}

function parseRateLimit() {
	const rateLimit = config.transport.rateLimit;
	if (!rateLimit) return null;

	let rateLimitBytesPerSecond;
	if (Number.isFinite(rateLimit)) {
		if (rateLimit === 0) return null;
		else if (rateLimit < 0) throw new Error("Invalid rate limit");
		else rateLimitBytesPerSecond = rateLimit;
	} else if (typeof rateLimit === "string") rateLimitBytesPerSecond = parseTransferRate(rateLimit);
	else throw new Error("Invalid rate limit");

	return {
		bytesPerSecond: rateLimitBytesPerSecond
	};
}

async function run() {
	printLogo();
	log(`NodeJS ${process.version}, OS ${os.version()}`);

	processLogLevel();
	processConfig();

	const node = new ntun.Node();

	if (!config.input && !config.output ||
		config.input && config.output) throw new Error("One of input or output must be specified");

	if (config.input) {
		switch (config.input.type) {
			case INPUT_TYPES.SOCKS5: {
				const port = config.input.port;
				if (!checkPort(port)) throw new Error("Invalid port");

				node.connection = new ntun.inputConnections.Socks5InputConnection(node, { port });

				break;
			}
			default: throw new Error(`Unknown input type ${config.input.type}`);
		}
	}

	if (config.output) {
		switch (config.output.type) {
			case OUTPUT_TYPES.DIRECT: {
				node.connection = new ntun.outputConnections.DirectOutputConnection(node);

				break;
			}
			default: throw new Error(`Unknown output type ${config.input.type}`);
		}
	}

	if (!config.transport) throw new Error("Transport must be specified");

	const transportOptions = {};
	let transportConstructor = null;

	switch (config.transport.type) {
		case TRANSPORT.TCP: {
			const host = config.transport.host;
			if (host &&
				!checkHost(host)) throw new Error("Invalid host");

			const port = config.transport.port;
			if (!checkPort(port)) throw new Error("Invalid port");

			transportOptions.host = host;
			transportOptions.port = port;

			if (config.input) {
				transportConstructor = ntun.transports.TCPClientTransport;
			} else if (config.output) {
				transportConstructor = ntun.transports.TCPServerTransport;
			}

			break;
		}
		case TRANSPORT.WEBSOCKET: {
			const host = config.transport.host;
			if (host &&
				!checkHost(host)) throw new Error("Invalid host");

			const port = config.transport.port;
			if (!checkPort(port)) throw new Error("Invalid port");

			transportOptions.host = host;
			transportOptions.port = port;

			if (config.input) {
				transportConstructor = ntun.transports.WebSocketClientTransport;
			} else if (config.output) {
				transportConstructor = ntun.transports.WebSocketServerTransport;
			}

			break;
		}
		case TRANSPORT.VK_CALLS: {
			let joinId;
			try {
				joinId = VkTransport.getJoinId(config.transport.joinId || config.transport.joinLink);
			} catch {
				throw new Error("Invalid vk call joinId or join link");
			}

			transportOptions.joinId = joinId;

			if (config.input) {
				transportConstructor = VkTransport.VkCallSignalServerTransport;
			} else if (config.output) {
				transportConstructor = VkTransport.VkCallSignalServerTransport;
			}

			break;
		}
		case TRANSPORT.VK_WEBRTC: {
			let joinId;
			try {
				joinId = VkTransport.getJoinId(config.transport.joinId || config.transport.joinLink);
			} catch {
				throw new Error("Invalid vk call joinId or join link");
			}

			transportOptions.joinId = joinId;

			if (config.input) {
				transportConstructor = VkTransport.VkWebRTCTransport;
			} else if (config.output) {
				transportConstructor = VkTransport.VkWebRTCTransport;
			}

			break;
		}
		default: throw new Error(`Unknown transport type ${config.transport.type}`);
	}

	transportOptions.cipher = config.transport.cipher;

	transportOptions.rateLimit = parseRateLimit();

	node.transport = new transportConstructor(transportOptions);

	node.start();
	node.transport.start();

	global.ntun = {
		node,
		transport: node.transport
	};
}

run().catch(error => {
	log(chalk.red(error.message));

	return process.exit(1);
});
