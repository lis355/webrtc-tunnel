import childProcess from "node:child_process";

import { log } from "../utils/log.js";

export default async function exec(str) {
	let stdoutString = "";
	let stderrString = "";

	return new Promise((resolve, reject) => {
		const child = childProcess.exec(str);
		child.stdout
			.on("data", data => {
				data.toString().split("\n").filter(Boolean).forEach(line => {
					log("[" + str + "]", line.toString().trim());
				});

				stdoutString += data.toString();
			});

		child.stderr
			.on("data", data => {
				data.toString().split("\n").filter(Boolean).forEach(line => {
					error("[" + str + "]", line.toString().trim());
				});

				stderrString += data.toString();
			});

		child
			.on("error", error => {
				return reject(error);
			})
			.on("close", () => {
				return resolve({ stdoutString, stderrString });
			});
	});
}
