/**
 * A filesystem in a Map, covering exactly the surface persistence uses.
 *
 * Separate from the orchestrator helper's `MemoryExecutionEnv` on purpose: the
 * persistence model is meant to be exercisable without the runtime, and a test
 * that reaches for the orchestrator helper drags the whole agent stack in with
 * it.
 *
 * `files` is public so a test can plant a torn line or a hand-built log that no
 * writer would produce.
 */

import type { FileError, FileInfo, Result } from "@arcadialin/agent-core";
import { err, ok, FileError as PiFileError } from "@arcadialin/agent-core";
import type { PersistenceFileSystem } from "../../src/core/persistence/index.ts";

export class MemoryFileSystem implements PersistenceFileSystem {
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);

	private _normalize(path: string): string {
		return path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private _dirname(path: string): string {
		const normalized = this._normalize(path);
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this._normalize(path.startsWith("/") ? path : `/${path}`));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(this._normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const normalized = this._normalize(path);
		const content = this.files.get(normalized);
		if (content === undefined) {
			return err(new PiFileError("not_found", `Not found: ${path}`, path));
		}
		return ok(content);
	}

	async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
		const read = await this.readTextFile(path);
		if (!read.ok) return read;
		const lines = read.value.split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this._normalize(path);
		this.dirs.add(this._dirname(normalized));
		this.files.set(normalized, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this._normalize(path);
		const text = typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, (this.files.get(normalized) ?? "") + text);
		return ok(undefined);
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this._normalize(path);
		if (!this.dirs.has(dir)) {
			return err(new PiFileError("not_found", `Not found: ${path}`, path));
		}
		const entries: FileInfo[] = [];
		for (const candidate of this.dirs) {
			if (candidate !== dir && this._dirname(candidate) === dir) {
				entries.push(toFileInfo(candidate, "directory", 0));
			}
		}
		for (const [candidate, content] of this.files) {
			if (this._dirname(candidate) === dir) {
				entries.push(toFileInfo(candidate, "file", content.length));
			}
		}
		return ok(entries);
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this._normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const normalized = this._normalize(path);
		if (options?.recursive === false && !this.dirs.has(this._dirname(normalized))) {
			return err(new PiFileError("not_found", `No parent: ${path}`, path));
		}
		let current = "";
		for (const segment of normalized.split("/").filter(Boolean)) {
			current = `${current}/${segment}`;
			this.dirs.add(current);
		}
		return ok(undefined);
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const normalized = this._normalize(path);
		const prefix = `${normalized}/`;
		const existed = this.files.has(normalized) || this.dirs.has(normalized);
		if (!existed && options?.force !== true) {
			return err(new PiFileError("not_found", `Not found: ${path}`, path));
		}
		this.files.delete(normalized);
		this.dirs.delete(normalized);
		if (options?.recursive === true) {
			for (const candidate of [...this.files.keys()]) {
				if (candidate.startsWith(prefix)) this.files.delete(candidate);
			}
			for (const candidate of [...this.dirs]) {
				if (candidate.startsWith(prefix)) this.dirs.delete(candidate);
			}
		}
		return ok(undefined);
	}
}

function toFileInfo(path: string, kind: "file" | "directory", size: number): FileInfo {
	return { name: path.slice(path.lastIndexOf("/") + 1), path, kind, size, mtimeMs: 0 };
}
