import http from "node:http";

const port = Number(process.argv[2]);

http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end(req.socket.remoteAddress);
})
	.listen(port, "0.0.0.0", () => {
		console.log(`testHttpServer started on http://localhost:${port}`);
	});
