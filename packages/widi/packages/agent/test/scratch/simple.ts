import { homedir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import {
	AgentHarness,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	formatPromptTemplateInvocation,
	formatSkillsForSystemPrompt,
	loadSourcedPromptTemplates,
	loadSourcedSkills,
	type PromptTemplate,
	Session,
	type Skill,
} from "../../src/index.ts";

type Source = { type: "project" | "user" | "path"; dir: string };
type SourcedSkill = Skill & { source: Source };
type SourcedPromptTemplate = PromptTemplate & { source: Source };

const env = new NodeExecutionEnv({ cwd: process.cwd() });

const source = (type: Source["type"], dir: string) => ({ path: dir, source: { type, dir } });
const { skills: sourcedSkills } = await loadSourcedSkills<Source, SourcedSkill>(
	env,
	[
		source("project", join(env.cwd, ".pi/skills")),
		source("user", join(homedir(), ".pi/agent/skills")),
		source("path", join(env.cwd, "../../../pi-skills")),
	],
	(skill, source) => ({ ...skill, source }),
);
const { promptTemplates: sourcedPromptTemplates } = await loadSourcedPromptTemplates<Source, SourcedPromptTemplate>(
	env,
	[source("project", join(env.cwd, ".pi/prompts")), source("user", join(homedir(), ".pi/agent/prompts"))],
	(promptTemplate, source) => ({ ...promptTemplate, source }),
);

const models = createModels();
models.setProvider(openaiProvider());
models.setProvider(cloudflareAIGatewayProvider());
const model = models.getModel("openai", "gpt-5.5");
// const model = models.getModel("cloudflare-ai-gateway", "claude-haiku-4-5");
if (!model) {
	console.log("Model not found");
	process.exit(-1);
}

const session = new Session(new InMemorySessionStorage());
const agent = new AgentHarness({
	session,
	models,
	model,
	thinkingLevel: "low",
	tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
	toolContext: { env },
	// Resources are the application's: the harness only ever sees the composed
	// system prompt and, below, an already expanded prompt.
	systemPrompt: () =>
		[
			"You are a helpful assistant.",
			formatSkillsForSystemPrompt(sourcedSkills.map(({ skill }) => skill)),
			`Current working directory: ${env.cwd}`,
		]
			.filter((part) => part.length > 0)
			.join("\n\n"),
});

const template = sourcedPromptTemplates.find(({ promptTemplate }) => promptTemplate.name === "review");
const response = await agent.prompt(
	template
		? formatPromptTemplateInvocation(template.promptTemplate, ["README.md"])
		: "What skills do you have? Any duplicates? Also use bash to get the current date and time, then read README.md and tell me what this project is about.",
);
console.log(response);
