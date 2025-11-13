import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { windowsBatFilePath } from "./appInfo.js";

const currentScriptDirname = path.dirname(url.fileURLToPath(import.meta.url));

fs.writeFileSync(windowsBatFilePath, `@echo off
node "${path.resolve(currentScriptDirname, "..", "ntun.cli.js")}" %*
`);

console.log(`${windowsBatFilePath} created`);
