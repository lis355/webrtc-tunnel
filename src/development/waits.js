import ntun from "../ntun.js";

function waitForStarted(obj) {
	return new Promise(resolve => {
		if (obj.workingState === ntun.WORKING_STATE.WORKING) return resolve();
		else obj.once("started", resolve);
	});
}

function waitForStopped(obj) {
	return new Promise(resolve => {
		if (obj.workingState === ntun.WORKING_STATE.IDLE) return resolve();
		else obj.once("stopped", resolve);
	});
}

function waitForConnected(obj) {
	return new Promise(resolve => {
		if (obj.isConnected) return resolve();
		else obj.once("connected", resolve);
	});
}

function waitForDisconnected(obj) {
	return new Promise(resolve => {
		if (!obj.isConnected) return resolve();
		else obj.once("disconnected", resolve);
	});
}

export default {
	waitForStarted,
	waitForStopped,
	waitForConnected,
	waitForDisconnected
};
