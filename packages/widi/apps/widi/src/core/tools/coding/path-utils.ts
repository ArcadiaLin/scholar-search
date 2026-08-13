import { isAbsolute, resolve } from "node:path";

export function resolveToCwd(filePath: string, cwd: string): string {
	return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
}
