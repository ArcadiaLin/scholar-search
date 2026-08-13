import { constants } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	realpath as fsRealpath,
	writeFile as fsWriteFile,
} from "node:fs/promises";

export type CodingToolAccessMode = "exists" | "read" | "write" | "readwrite";

export interface CodingToolFileOperations {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	access(path: string, mode?: CodingToolAccessMode): Promise<void>;
	realpath(path: string): Promise<string>;
}

export function createLocalCodingToolFileOperations(): CodingToolFileOperations {
	return {
		readFile: (path) => fsReadFile(path),
		writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
		mkdir: async (path) => {
			await fsMkdir(path, { recursive: true });
		},
		access: (path, mode = "exists") => fsAccess(path, toNodeAccessMode(mode)),
		realpath: (path) => fsRealpath(path),
	};
}

export function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function toNodeAccessMode(mode: CodingToolAccessMode): number {
	switch (mode) {
		case "exists":
			return constants.F_OK;
		case "read":
			return constants.R_OK;
		case "write":
			return constants.W_OK;
		case "readwrite":
			return constants.R_OK | constants.W_OK;
	}
}
