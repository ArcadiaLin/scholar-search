import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Self-reference so harness tests can import the package's public surface by
// name; pi-ai resolves from node_modules as a published dependency.
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/harness/**/*.test.ts"],
		coverage: {
			provider: "v8",
			all: true,
			include: ["src/harness/**/*.ts", "src/agent.ts", "src/agent-loop.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage/harness",
		},
	},
	resolve: {
		alias: [{ find: /^@widi\/agent-core$/, replacement: agentSrcIndex }],
	},
});
