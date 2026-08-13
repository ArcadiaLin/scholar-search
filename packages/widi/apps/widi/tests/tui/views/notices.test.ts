import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createTuiApplicationState } from "../../../src/tui/state.ts";
import { NoticeView } from "../../../src/tui/views/notices.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("NoticeView", () => {
	it("wraps full notices without abbreviating login URLs", () => {
		const state = createTuiApplicationState();
		const url = `https://auth.example.test/oauth/authorize?${"state=a".repeat(120)}&complete=yes`;
		state.globalNotices.push({
			id: "login-url",
			kind: "application",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: `Login: open ${url}`,
			textMode: "full",
		});

		const lines = new NoticeView(state).render(40);
		const output = lines.map((line) => line.replace(ANSI_SEQUENCE, "").trim()).join("");

		expect(output).toContain(url);
		expect(output).not.toContain("…");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});
});
