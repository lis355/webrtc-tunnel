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

			child.stderr
				.on("data", data => {
					data.toString().split("\n").filter(Boolean).forEach(line => {
						console.error("[" + str + "]", line.toString().trim());
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

	await exec("curl -s http://jdam.am:8302");
	await exec("curl -s https://jdam.am/api/ip");

	exec("node ./node.cli.js -o -t tcp 8081");

	await new Promise(resolve => setTimeout(resolve, 1000));

	exec("node ./node.cli.js -i 8080 --transport tcp localhost:8081");

	await new Promise(resolve => setTimeout(resolve, 1000));

	await exec("curl -s -x socks5://127.0.0.1:8080 http://jdam.am:8302");
	await exec("curl -s -x socks5://127.0.0.1:8080 https://jdam.am/api/ip");

	process.exit(0);
}

run();
