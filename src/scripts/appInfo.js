import info from "../../package.json" with { type: "json" };

export const name = info.name;

export const windowsBatFilePath = `C:/windows/${name}.bat`;
