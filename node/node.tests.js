import childProcess from "node:child_process";

async function run() {
	async function exec(str) {
		return new Promise((resolve, reject) => {
			const child = childProcess.exec(str);
			child.stdout
				.on("data", data => {
					data.toString().split("\n").filter(Boolean).forEach(line => {
						console.log("[" + str + "]", line.toString().trim());
					});
				});

			child
				.on("error", error => {
					return reject(error);
				})
				.on("close", () => {
					return resolve();
				});
		});
	}

	await exec("curl https://jdam.am/api/ip");

	exec("node ./node.cli.js -o -t tcp 8081");

	await new Promise(resolve => setTimeout(resolve, 500));

	exec("node ./node.cli.js -i 8080 --transport tcp localhost:8081");

	await new Promise(resolve => setTimeout(resolve, 500));

	await exec("curl -x socks5://127.0.0.1:8080 https://jdam.am/api/ip");
}

run();
