import exec from "./development/exec.js";

async function run() {
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
