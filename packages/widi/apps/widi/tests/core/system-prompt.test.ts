import { describe, expect, it } from "vitest";
import {
	buildAgentSystemPrompt,
	formatProjectContextForSystemPrompt,
	formatToolGuidanceForSystemPrompt,
} from "../../src/core/system-prompt.ts";

const skill = {
	name: "code-review",
	description: "Review code for issues.",
	content: "BODY",
	filePath: "/skills/code-review/SKILL.md",
};

describe("buildAgentSystemPrompt", () => {
	it("deduplicates guidance and omits the section without contributions", () => {
		expect(
			formatToolGuidanceForSystemPrompt([
				{ name: "a", promptSnippet: "First", promptGuidelines: ["Shared."] },
				{ name: "b", promptGuidelines: ["Shared.", "  ", "Extra."] },
				{ name: "c" },
			]),
		).toBe("Available tools:\n- a: First\n\nTool guidelines:\n- Shared.\n- Extra.");
		expect(formatToolGuidanceForSystemPrompt([{ name: "plain" }])).toBe("");
		expect(buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [{ name: "plain" }] })).toBe(
			"base prompt",
		);
	});

	// Naming the agent follows the caller passing an id, not what its tools are
	// called. Whether anything will address it by that id is the caller's to know.
	it("names the agent exactly when it was given an id", () => {
		expect(
			buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [], agentId: "worker-2" }),
		).toBe("base prompt\n\nYou are agent worker-2. Other agents address you by that id.");
		expect(buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [] })).toBe("base prompt");
	});

	it("keeps the base system prompt when skills are absent or model-hidden", () => {
		expect(
			buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [], includeSkills: true }),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				skills: [{ ...skill, disableModelInvocation: true }],
				activeTools: [],
				includeSkills: true,
			}),
		).toBe("base prompt");
	});

	// The role asks for the listing or does not get one. The tools it holds are
	// not consulted: whether any of them can open a skill file is not knowable
	// from here, and a role that lists none still gets `/skill`.
	it("lists skills only when the role asked for the listing", () => {
		expect(
			buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [skill], activeTools: [{ name: "read" }] }),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				skills: [skill],
				activeTools: [{ name: "read" }],
				includeSkills: false,
			}),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [skill], activeTools: [], includeSkills: true }),
		).toContain("<available_skills>");
	});

	it("appends sections in the order given and drops blank ones", () => {
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				skills: [],
				activeTools: [],
				appendSections: ["  from profile  ", "   ", "from extension", ""],
			}),
		).toBe("base prompt\n\nfrom profile\n\nfrom extension");
	});

	it("places appended sections between the tool guidance and the skills listing", () => {
		const prompt = buildAgentSystemPrompt({
			basePrompt: "base prompt",
			skills: [skill],
			activeTools: [{ name: "read", promptSnippet: "Read file contents" }],
			appendSections: ["APPENDED"],
			contextFiles: [{ path: "/repo/AGENTS.md", content: "RULES" }],
			includeSkills: true,
			cwd: "/repo",
		});
		const order = [
			"base prompt",
			"Available tools:",
			"APPENDED",
			"<project_context>",
			"<available_skills>",
			"Current working directory: /repo",
		].map((marker) => prompt.indexOf(marker));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("inlines project context files in the pi wrapper format", () => {
		expect(
			formatProjectContextForSystemPrompt([
				{ path: "/repo/AGENTS.md", content: "ROOT RULES" },
				{ path: "/repo/app/AGENTS.md", content: "APP RULES" },
			]),
		).toBe(
			[
				"<project_context>",
				"",
				"Project-specific instructions and guidelines:",
				"",
				'<project_instructions path="/repo/AGENTS.md">',
				"ROOT RULES",
				"</project_instructions>",
				"",
				'<project_instructions path="/repo/app/AGENTS.md">',
				"APP RULES",
				"</project_instructions>",
				"",
				"</project_context>",
			].join("\n"),
		);
		expect(formatProjectContextForSystemPrompt([])).toBe("");
		expect(buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [], contextFiles: [] })).toBe(
			"base prompt",
		);
	});

	it("states the working directory only when one is given, in one path shape", () => {
		expect(buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [] })).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({ basePrompt: "base prompt", skills: [], activeTools: [], cwd: "C:\\repo\\app" }),
		).toBe("base prompt\n\nCurrent working directory: C:/repo/app");
	});
});

/**
 * The composed prompt verbatim, not section by section: the tests above pin
 * which sections appear and in what order, which is what the composition rules
 * are about, but they would not notice a changed separator or a reworded
 * listing. These lock the text the model actually receives, so a refactor that
 * only means to move where the skills come from has to leave it byte-identical.
 */
describe("buildAgentSystemPrompt composed text", () => {
	const everySection = {
		basePrompt: "You are a reviewer.",
		activeTools: [
			{ name: "read", promptSnippet: "Read file contents", promptGuidelines: ["Read before editing."] },
			{ name: "send_message" },
		],
		agentId: "worker-2" as const,
		appendSections: ["FROM PROFILE", "FROM EXTENSION"],
		contextFiles: [{ path: "/repo/AGENTS.md", content: "ROOT RULES" }],
		includeSkills: true,
		cwd: "/repo",
	};

	it("composes every section", () => {
		expect(buildAgentSystemPrompt({ ...everySection, skills: [skill] })).toMatchInlineSnapshot(`
			"You are a reviewer.

			You are agent worker-2. Other agents address you by that id.

			Available tools:
			- read: Read file contents

			Tool guidelines:
			- Read before editing.

			FROM PROFILE

			FROM EXTENSION

			<project_context>

			Project-specific instructions and guidelines:

			<project_instructions path="/repo/AGENTS.md">
			ROOT RULES
			</project_instructions>

			</project_context>

			The following skills provide specialized instructions for specific tasks.
			Read the full skill file when the task matches its description.
			When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

			<available_skills>
			  <skill>
			    <name>code-review</name>
			    <description>Review code for issues.</description>
			    <location>/skills/code-review/SKILL.md</location>
			  </skill>
			</available_skills>

			Current working directory: /repo"
		`);
	});

	it("drops only the listing when no skill is model-visible", () => {
		expect(
			buildAgentSystemPrompt({ ...everySection, skills: [{ ...skill, disableModelInvocation: true }] }),
		).toMatchInlineSnapshot(`
			"You are a reviewer.

			You are agent worker-2. Other agents address you by that id.

			Available tools:
			- read: Read file contents

			Tool guidelines:
			- Read before editing.

			FROM PROFILE

			FROM EXTENSION

			<project_context>

			Project-specific instructions and guidelines:

			<project_instructions path="/repo/AGENTS.md">
			ROOT RULES
			</project_instructions>

			</project_context>

			Current working directory: /repo"
		`);
	});

	// Same input with the listing left unasked-for: only that section goes.
	it("drops only the listing when the role did not ask for one", () => {
		const { includeSkills: _asked, ...withoutListing } = everySection;
		expect(buildAgentSystemPrompt({ ...withoutListing, skills: [skill] })).toMatchInlineSnapshot(`
			"You are a reviewer.

			You are agent worker-2. Other agents address you by that id.

			Available tools:
			- read: Read file contents

			Tool guidelines:
			- Read before editing.

			FROM PROFILE

			FROM EXTENSION

			<project_context>

			Project-specific instructions and guidelines:

			<project_instructions path="/repo/AGENTS.md">
			ROOT RULES
			</project_instructions>

			</project_context>

			Current working directory: /repo"
		`);
	});
});
