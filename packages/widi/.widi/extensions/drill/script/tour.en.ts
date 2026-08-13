import { LAST_SPAWNED_AGENT, text, thinking, toolCall } from "./beats.ts";
import type { DrillScript } from "./types.ts";

/** The role the tour delegates to. Registered by the core half at activation. */
export const DRILL_HELPER_PROFILE_ID = "drill-helper";

const HELPER_TASK = "Count to three, then stop.";

/**
 * The guided tour, for somebody opening WIDI for the first time.
 *
 * Four rules hold the wording together.
 *
 * Nothing the model says is a fact about the product. The model here is a
 * script, and letting a scripted voice make claims would teach a new user to
 * trust the wrong half; facts are narration, which is the interface speaking as
 * itself.
 *
 * The tour explains itself. Every act says how the drill did what it just did,
 * because the drill is an extension and what a new user most needs to believe is
 * that they could write one too. `narrate` is what is about to happen; `review`
 * is how it was done.
 *
 * It survives any working directory, so the one real file tool it runs is `ls`.
 *
 * And it stops often: a tour that scrolls past unread has taught nobody
 * anything.
 */
export const tourEn: DrillScript = {
	language: "en",
	title: "A guided tour of WIDI",
	estimatedMinutes: 3,
	steps: [
		{
			id: "tour.welcome",
			chapter: "tour",
			narrate: [
				"Welcome. This is a rehearsal, and it takes about three minutes.",
				"",
				"It runs right here, on the agent you already have open. Nothing was created",
				"for it and nothing will be taken away afterwards. Two things changed when it",
				"started - the model became a scripted one, and a few read-only tools were",
				"switched on - and both go back to what they were when it ends.",
				"",
				"WIDI is a multi-agent orchestrator built on pi - thanks to pi's contributors.",
				"",
				"I am not WIDI, by the way. I am drill, an extension, and I will keep saying",
				"how I do each thing as I do it.",
			],
			pause: "Take your time. Press the advance key when you want to begin.",
			review: [
				"That key is mine. I registered it as ext.drill.next through registerShortcut,",
				"which puts it in the same table as every built-in binding - so it appears in",
				"the footer, and you can rebind it in keybindings.json like any other action.",
				"",
				"I am also two halves at once. One runs inside this agent and can reach the",
				"model, the tools and the session. The other runs out here in the terminal and",
				"can reach the screen. They never see each other; they talk over an event bus.",
			],
		},
		{
			id: "tour.intro",
			chapter: "tour",
			narrate: [
				"First, a plain question with a plain answer.",
				"",
				"The line below is already waiting in your editor. Read it,",
				"then press Enter yourself - I never send anything for you.",
			],
			say: "What are you?",
			turns: [
				[
					thinking("Someone new. Lead with what I am, not with what I can do."),
					text(
						"I am WIDI: an orchestrator you talk to in a terminal.\n\n" +
							"One conversation is one **agent**. I can run several at once, hand work between them, " +
							"and show you any of them.",
					),
				],
			],
			review: [
				"That was a real turn. Editor, command engine, orchestrator, harness, provider -",
				"every link the shipping one except the last.",
				"",
				"How: I registered a provider with registerProvider and pointed this agent at",
				"it for the duration. Nothing upstream can tell the difference, which is the",
				"whole reason a rehearsal is worth anything - if I had faked the transcript",
				"instead, this would prove nothing about the real path.",
				"",
				"The line itself reached your editor through the editor capability's setText.",
				"Note what I could not do: there is no submit. Writing into your editor is mine;",
				"pressing Enter is yours, and the entry on the branch records it as yours.",
			],
			watch: "The thinking block above the reply - collapsed by default, ctrl+o opens it.",
		},
		{
			id: "tour.tools",
			chapter: "tour",
			narrate: [
				"Next, a tool. WIDI has built-in ones for reading, searching, editing",
				"and running commands, and here they are not faked.",
				"",
				"The next line uses one for real. Watch for the card that appears between",
				"the question and the answer - that is the tool call itself.",
			],
			say: "What is in this directory?",
			turns: [
				[thinking("Look before answering."), toolCall("ls", { path: "." })],
				[
					text(
						"That is the directory you started me in, listed by the real `ls` tool - " +
							"same code path a production run takes, same card on screen.",
					),
				],
			],
			review: [
				"The tool call was real; only the sentence around it was written in advance.",
				"",
				"How: the tools are core's, not mine - I only asked for a few to be switched on",
				"while the tour lasts. Reading and delegating, nothing that writes or executes.",
				"An extension can also register tools of its own and patch the built-in ones,",
				"but a tour has no business writing to your disk.",
			],
			watch: "The tool card - it folds, it opens per item, and it prints how long the call took.",
		},
		{
			id: "tour.agents",
			chapter: "tour",
			narrate: [
				"Now the part the name is about. WIDI is an orchestrator, not one agent:",
				"it can create another agent, hand it a job, and carry on.",
				"",
				"The next line asks for exactly that. The helper it creates is a separate",
				"conversation with its own context - it cannot see this one.",
			],
			say: "Spawn a helper and ask it to count to three.",
			turns: [
				[
					thinking("Small job, no context needed. A fresh agent on the helper role will do."),
					toolCall("spawn_agent", { agents: [{ profile: DRILL_HELPER_PROFILE_ID, task: HELPER_TASK, watch: false }] }),
				],
				[
					text(
						"Done. The helper is its own agent with its own transcript, and it has the task now.\n\n" +
							"I am not waiting on it. In real work I would ask to be woken when it stops; " +
							"here you can just go and look.",
					),
				],
			],
			review: [
				"Look at the strip at the bottom: two agents now, and the indent says which one",
				"created the other. It is a tree, not a list.",
				"",
				"How: spawning needs a role to spawn into, and I cannot know what roles you",
				"have - this tour runs in whatever directory you started in. So I ship one.",
				"registerProfile added drill-helper when I loaded, it needs no entry in your",
				"settings, and a role of your own by that name would shadow mine.",
			],
			watch: "The new row in the agent strip, and its indent under this one.",
		},
		{
			id: "tour.strip",
			chapter: "tour",
			narrate: [
				"You can go and look at that helper yourself.",
				"",
				"Press the down arrow at the end of an empty editor and the agent panel opens.",
				"Left and right move between agents; Enter puts one on screen. Whatever you",
				"switch to, its whole transcript is there - each agent keeps its own.",
				"",
				"Come back to this one when you have had a look. The tour waits.",
			],
			pause: "Try the down arrow now, then come back here and press the advance key.",
		},
		{
			id: "tour.dispose",
			chapter: "tour",
			narrate: [
				"An agent you have stopped needing does not go away by itself.",
				"Delegation is a loop with an end, and this is the end of it.",
			],
			say: "Dispose the helper.",
			turns: [
				[toolCall("dispose_agent", { agentIds: [LAST_SPAWNED_AGENT], reason: "the rehearsal is done with it" })],
				[
					text(
						"The helper is closed. Its session is kept, so the same conversation " +
							"can be reopened later rather than started again from nothing.",
					),
				],
			],
			review: [
				"How: a script is written before a run and an agent id is minted during one, so",
				"that argument is the one thing I could not write down. The provider filled it",
				"in from the spawn's own tool result. Everything else in these turns is literal.",
			],
			watch: "The helper's row leaving the strip.",
		},
		{
			id: "tour.interface",
			chapter: "tour",
			narrate: [
				"The other half of WIDI is this screen, and it is not decoration.",
				"",
				"Every line I have said to you is an extension row: I put them there with the",
				"chat capability, they cost no turn, and they are on no branch - reopen this",
				"session tomorrow and none of my narration comes back.",
				"",
				"The progress text and the key hints are segments, in the working line and the",
				"footer. The opening banner was a notice. An extension can also stage a",
				"sentence in your editor for you to edit or throw away, queue work while the",
				"agent is busy, and turn that queue into an interruption.",
				"",
				"Colours are yours too. Try /theme prism, or /theme default to come back.",
			],
			pause: "Try /theme now if you like - the whole screen repaints and nothing restarts.",
			review: [
				"One last piece of how. I declare a division called tour, and everything you",
				"just saw is registered inside it - so /division drill/tour switches the whole",
				"thing off, and a switched-off division never registers anything rather than",
				"registering and then skipping.",
			],
		},
		{
			id: "tour.close",
			chapter: "tour",
			narrate: [
				"That is the tour. Your model and tools go back to what they were.",
				"",
				"The table below is what this run actually touched. It is counted, not written",
				"down in advance, so it cannot flatter anyone - including me.",
			],
		},
	],
	asides: [{ line: HELPER_TASK, turns: [[text("One.\n\nTwo.\n\nThree.\n\nThat is three. Nothing else to do here.")]] }],
	reportTitle: "What this drill actually exercised",
	reportColumns: ["Area", "Result"],
	closing: "WIDI is young. The table above is what it does today, not what it hopes to.",
};
