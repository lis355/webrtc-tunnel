import fs from "node:fs";

import { windowsBatFilePath } from "./appInfo.js";

fs.rmSync(windowsBatFilePath);

console.log(`${windowsBatFilePath} removed`);
