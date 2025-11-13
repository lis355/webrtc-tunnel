import childProcess from "node:child_process";

import { config as dotenv } from "dotenv-flow";

import exec from "./exec.js";
import log from "../utils/log.js";
import urlTests from "./urlTests.js";

dotenv();

function executeChildProcess(str) {
	const child = childProcess.exec(str);
	child.stdout
		.on("data", data => {
			data.toString().split("\n").filter(Boolean).forEach(line => {
				console.log("[" + str + "]", line.toString().trim());
			});
		});

	child.stderr
		.on("data", data => {
			data.toString().split("\n").filter(Boolean).forEach(line => {
				console.error("[" + str + "]", line.toString().trim());
			});
		});

	child
		.on("error", error => {
			console.error("[" + str + "]", error.message);
		});

	return child;
}

async function testConfiguration(serverStr, clientStr) {
	const serverProcess = executeChildProcess(serverStr);
	await new Promise(resolve => setTimeout(resolve, 1000));

	const clientProcess = executeChildProcess(clientStr);
	await new Promise(resolve => setTimeout(resolve, 1000));

	await urlTests(8080);

	serverProcess.kill("SIGKILL");
	clientProcess.kill("SIGKILL");

	await new Promise(resolve => setTimeout(resolve, 3000));
}

async function run() {
	await exec("curl -s http://jdam.am:8302");
	await exec("curl -s https://jdam.am/api/ip");

	await testConfiguration(
		"node ./src/ntun.cli.js -o -t tcp 8081",
		"node ./src/ntun.cli.js -i 8080 -t tcp localhost:8081"
	);

	await testConfiguration(
		"node ./src/ntun.cli.js -o -t ws 8081",
		"node ./src/ntun.cli.js -i 8080 -t ws localhost:8081"
	);

	// await testConfiguration(
	// 	`node ./src/ntun.cli.js -o -t webrtc "${process.env.DEVELOP_WEB_RTC_SERVERS}"`,
	// 	`node ./src/ntun.cli.js -i 8080 -t webrtc "${process.env.DEVELOP_WEB_RTC_SERVERS}"`
	// );

	await testConfiguration(
		`node ./src/ntun.cli.js -o -t vk-calls "${process.env.DEVELOP_VK_JOIN_ID_OR_LINK}"`,
		`node ./src/ntun.cli.js -i 8080 -t vk-calls "${process.env.DEVELOP_VK_JOIN_ID_OR_LINK}"`
	);
}

run();
