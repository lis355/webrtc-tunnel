import express from "express";
import parser from "yargs-parser";

import { log } from "../../utils/log.js";

const argv = process.argv.slice(2);
const args = parser(argv);

const app = express();
app.use(express.text());

let currentOffer = "";
let currentAnswer = "";

app.use((req, res, next) => {
	log(`${req.method} ${req.url}`);

	return next();
});

app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Methods", "GET, POST");
	res.header("Access-Control-Allow-Headers", "Content-Type");

	return next();
});

app.get("/offer", (req, res) => {
	if (currentOffer) {
		log("offer unsettled");

		const sdp = currentOffer;

		currentOffer = "";
		currentAnswer = "";

		return res.send(sdp);
	}

	return res.sendStatus(404);
});

app.post("/offer", (req, res) => {
	currentOffer = req.body;

	log("offer settled");

	return res.sendStatus(200);
});

app.get("/answer", (req, res) => {
	if (currentAnswer) {
		log("answer unsettled");

		const sdp = currentAnswer;

		currentOffer = "";
		currentAnswer = "";

		return res.send(sdp);
	}

	return res.sendStatus(404);
});

app.post("/answer", (req, res) => {
	currentAnswer = req.body;

	log("answer settled");

	return res.sendStatus(200);
});

app.options(/(.*)/, (req, res) => {
	return res.sendStatus(200);
});

const port = args._[0] || 8030;
app.listen(port, () => {
	log(`Simple signal server listening on port ${port}`);
});
