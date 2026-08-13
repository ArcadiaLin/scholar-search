import { defineConfig } from "vitest/config";

// pi-ai is a published dependency here, so it resolves from node_modules; the
// upstream package aliased it to its sibling workspace source instead.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
