import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import codspeedPlugin from "@codspeed/vitest-plugin";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The vendored agent core is exercised from source so tests need no rebuild and
// traces point at real files. pi-ai and pi-tui are published packages and
// resolve from node_modules, which is what the runtime resolves as well.
const sourceAliases = [
	{
		find: "@arcadialin/agent-core/node",
		replacement: resolve(repoRoot, "packages/agent/src/node.ts"),
	},
	{
		find: "@arcadialin/agent-core",
		replacement: resolve(repoRoot, "packages/agent/src/index.ts"),
	},
];

export default defineConfig({
	plugins: [codspeedPlugin()],
	resolve: {
		alias: sourceAliases,
	},
});
