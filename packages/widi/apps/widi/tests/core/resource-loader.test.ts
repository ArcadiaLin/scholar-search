import { err, type FileInfo, FileError as PiFileError, type Result } from "@arcadialin/agent-core";
import { describe, expect, it } from "vitest";
import { ResourceLoader, type ResourceLoaderOptions } from "../../src/core/resource-loader.ts";
import { MemoryExecutionEnv } from "../helpers/orchestrator.ts";

const CWD = "/workspace";

function loader(files: Record<string, string>, overrides: Partial<ResourceLoaderOptions> = {}) {
	const env = new MemoryExecutionEnv();
	for (const [path, content] of Object.entries(files)) {
		env.files.set(path, content);
		// Register every ancestor so listDir and fileInfo resolve the tree.
		let dir = path.slice(0, path.lastIndexOf("/"));
		while (dir.length > 0) {
			env.dirs.add(dir);
			dir = dir.slice(0, dir.lastIndexOf("/"));
		}
	}
	return new ResourceLoader({ executionEnv: env, cwd: CWD, agentDir: `${CWD}/.widi`, ...overrides });
}

const template = ["---", "description: Run the self-check.", "---", "Go."].join("\n");

describe("ResourceLoader prompt templates", () => {
	it("loads a named template from the prompts directory", async () => {
		const result = await loader({ [`${CWD}/.widi/prompts/self-check.md`]: template }).loadPromptTemplates([
			"self-check",
		]);

		expect(result.promptTemplates.map(({ promptTemplate }) => promptTemplate)).toMatchObject([
			{ name: "self-check", content: "Go." },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reports a named template that no root produced", async () => {
		const result = await loader({ [`${CWD}/.widi/prompts/self-check.md`]: template }).loadPromptTemplates([
			"self-check",
			"typo",
		]);

		expect(result.promptTemplates.map(({ promptTemplate }) => promptTemplate.name)).toEqual(["self-check"]);
		// The failure a missing directory used to hide: the profile named it, so
		// silence is wrong even though the path is legitimately absent.
		expect(result.diagnostics).toMatchObject([
			{
				type: "warning",
				code: "not_found",
				message: expect.stringContaining('"typo" was not found'),
				path: `${CWD}/.widi/prompts/typo.md`,
			},
		]);
	});

	it("stays silent when no names are given and the root is absent", async () => {
		const result = await loader({}).loadPromptTemplates([]);

		expect(result.promptTemplates).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("ResourceLoader context files", () => {
	it("collects the agent dir file, then the ancestor chain ending at the cwd", async () => {
		const result = await loader(
			{
				"/AGENTS.md": "ROOT",
				"/workspace/AGENTS.md": "WORKSPACE",
				"/workspace/app/AGENTS.md": "APP",
				"/workspace/.widi/AGENTS.md": "AGENT DIR",
			},
			{ cwd: "/workspace/app" },
		).loadContextFiles();

		expect(result.contextFiles).toEqual([
			{ path: "/workspace/.widi/AGENTS.md", content: "AGENT DIR" },
			{ path: "/AGENTS.md", content: "ROOT" },
			{ path: "/workspace/AGENTS.md", content: "WORKSPACE" },
			{ path: "/workspace/app/AGENTS.md", content: "APP" },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("loads a context file when the cwd is the filesystem root", async () => {
		const result = await loader({ "/AGENTS.md": "ROOT" }, { cwd: "/", agentDir: "/.widi" }).loadContextFiles();

		expect(result.contextFiles).toEqual([{ path: "/AGENTS.md", content: "ROOT" }]);
		expect(result.diagnostics).toEqual([]);
	});

	it("takes one file per directory, in candidate order", async () => {
		const result = await loader({
			"/workspace/AGENTS.md": "AGENTS",
			"/workspace/CLAUDE.md": "CLAUDE",
		}).loadContextFiles();

		expect(result.contextFiles).toEqual([{ path: "/workspace/AGENTS.md", content: "AGENTS" }]);
	});

	it("takes every named file that exists, in the order named", async () => {
		const result = await loader({
			"/workspace/AGENTS.md": "AGENTS",
			"/workspace/CLAUDE.md": "CLAUDE",
			"/workspace/NOTES.md": "NOTES",
		}).loadContextFiles(["CLAUDE.md", "AGENTS.md", "MISSING.md"]);

		expect(result.contextFiles).toEqual([
			{ path: "/workspace/CLAUDE.md", content: "CLAUDE" },
			{ path: "/workspace/AGENTS.md", content: "AGENTS" },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reads a file once when the agent dir sits on the cwd chain", async () => {
		const result = await loader({ "/workspace/AGENTS.md": "SHARED" }, { agentDir: CWD }).loadContextFiles();

		expect(result.contextFiles).toEqual([{ path: "/workspace/AGENTS.md", content: "SHARED" }]);
	});

	it("leaves out project files when no cwd root is configured", async () => {
		const result = await loader(
			{ "/workspace/AGENTS.md": "PROJECT", "/workspace/.widi/AGENTS.md": "AGENT DIR" },
			{ contextFileRoots: [{ kind: "agent_dir", path: `${CWD}/.widi` }] },
		).loadContextFiles();

		expect(result.contextFiles).toEqual([{ path: "/workspace/.widi/AGENTS.md", content: "AGENT DIR" }]);
	});

	it("stays silent when no project file exists", async () => {
		const result = await loader({}).loadContextFiles();

		expect(result.contextFiles).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reports file inspection failures other than a missing candidate", async () => {
		class FailingFileInfoEnv extends MemoryExecutionEnv {
			override async fileInfo(path: string): Promise<Result<FileInfo, PiFileError>> {
				if (path === "/workspace/AGENTS.md") {
					return err(new PiFileError("permission_denied", "Cannot inspect project instructions", path));
				}
				return await super.fileInfo(path);
			}
		}
		const result = await new ResourceLoader({
			executionEnv: new FailingFileInfoEnv(),
			cwd: CWD,
			agentDir: `${CWD}/.widi`,
			contextFileRoots: [{ kind: "cwd", path: CWD }],
		}).loadContextFiles();

		expect(result.contextFiles).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				severity: "warning",
				code: "resource.context_file.file_info_failed",
				message: "Cannot inspect project instructions (/workspace/AGENTS.md)",
			},
		]);
	});
});

describe("ResourceLoader skills", () => {
	it("reports a named skill that no root produced", async () => {
		const result = await loader({
			[`${CWD}/.widi/skills/self-check/SKILL.md`]: [
				"---",
				"name: self-check",
				"description: Exercise every tool.",
				"---",
				"Steps.",
			].join("\n"),
		}).loadSkills(["self-check", "gone"]);

		expect(result.skills.map(({ skill }) => skill.name)).toEqual(["self-check"]);
		expect(result.diagnostics).toMatchObject([{ code: "not_found", path: `${CWD}/.widi/skills/gone` }]);
	});
});
