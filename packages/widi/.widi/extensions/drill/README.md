# drill

A rehearsal of WIDI, run by WIDI. It is the repository's one demonstration extension and the acceptance sample for the dual-entry contract: a package with a core half and a TUI half that never see each other.

`/drill` walks a person through a scripted conversation on the agent they already have open, and says how it did each thing as it does it. Every layer above the model is the shipping one. Only the bytes coming back are written in advance.

## Running it

```bash
npm run tui        # then: /drill
```

It needs to be enabled. `.widi/settings.json`:

```json
{ "enabledExtensions": ["drill"] }
```

An empty `enabledExtensions` array means none, not all.

Extensions load through jiti, so `.ts` sources work from the built CLI as well as from `npm run tui`.

Type-checking is separate from the app's, because the extension is loaded at runtime rather than built with it:

```bash
npx tsgo --noEmit -p .widi/extensions/drill/tsconfig.json
npx biome check --write .widi/extensions/drill
```

## Four hard rules

1. **It runs where the person already is, and puts everything back.** No stage agent, no switching: `/drill` from a cold start has already materialised an empty agent, and moving someone to a second one before the tour has explained what an agent is teaches a switch instead of the thing they came for. Rehearsal is a mode - the model becomes the scripted one, a few read-only tools are switched on - and `finally` hands both back however the run ends, including when the terminal is quitting under it.
2. **The human presses Enter.** The director writes the line into the editor and stops. There is no `submitEditor()` and there will not be one: what the drill claims about a turn has to be true of a turn a person actually started.
3. **It stops often.** Narration arrives a line at a time and every act ends somewhere a person can catch up, look around, and go on when they are ready. A tour that scrolls past unread has taught nobody anything, so pacing is a feature and not a delay.
4. **`watch` lines are printed, not asserted.** They are what a person should look at. A guided tour fails when it is ugly or confusing, which no assertion catches.

## Tokens

One character is one token, emitted on a fixed clock. Not an approximation of a real tokenizer, and deliberately not one: a drill that guessed at token counts would publish a number nobody can check. A character is a unit the reader can see, so the gauge on screen and the text in front of them are the same fact.

## Layout

```
protocol.ts   what the two halves say to each other, and nothing else
script/       the rehearsal, pure data, read by both halves
core/         the half inside an agent: the model, the profile, the stage, the sensors
tui/          the half in the terminal: the director
```

`core/` and `tui/` never import each other. The two hosts load the two entry points independently and the only channel between them is the extension event bus. Treat a first import across that line as a bug, not a shortcut.

`script/` holds no API imports at all. That is what lets both halves read it: the director needs the lines and the narration, the provider needs the turns, and neither should have to pull the other's world in to get them.

## How a beat works

```
director            bus                     core runtime
--------            ---                     ------------
narrate (paced)                             (nothing; narration costs no turn)
pause for a key
setEditorText(say)
                                            human presses Enter
                                            harness -> provider -> scripted turn
                    drill:turn-settled  <-  the agent went idle
review: how it was done
```

The provider has no cursor and must not get one. There is one core runtime per agent and they all hear the same bus, so anything holding a cursor over there would race its own copies. Instead each provider callback derives its own key from the context it was handed: the last user message, plus how many assistant messages have already answered it. The second half is not optional - across a tool round trip the last user message never changes, so a table keyed by text alone would replay the same tool call forever.

The consequence for a script author is one rule: **`say` is unique within a language**.

A line is matched exactly first, then by the longest key it ends with. The suffix rule exists for one real case: a message delivered from another agent arrives with an attribution header in front of it, so the stage's helper never sees the bare task line the script wrote.

Two run-time facts a written script cannot hold have escapes rather than guesses. `LAST_SPAWNED_AGENT` is replaced with the id of the agent an earlier beat created, read back out of the spawn's own tool result. Everything else in a beat is literal.

## The helper role

The tour delegates, and delegation needs a profile id. A script cannot know what roles a given installation has, so drill ships its own through `api.registerProfile` (`core/profile.ts`) - no tools, spawned to answer one line and disposed. Its session is kept, because the dispose act tells the person a closed agent's transcript survives - the one claim in the tour they can walk away and verify.

An extension-registered profile needs no entry in `enabledProfiles`: enabling the extension is the decision, and asking for the same consent twice would make every such extension look broken on install. A profile of the user's own with the same id still shadows it. The registration is leased per agent like a provider's, so it lives exactly as long as some agent has the extension loaded.

## One division

Everything drill does is registered inside a division called `tour`, so `/division drill/tour` switches the whole extension off - and a switched-off division never registers anything rather than registering and then declining to act. The tour's last act says exactly this, which is the reason it has to be true.

The one thing outside the division is the roll-call handler that answers `drill:hello`. With the division off there is nothing to run, but somebody still has to say so, or `/drill` would wait on a reply that is never coming.

The five developer chapters the design sketched (`basic`, `tools`, `multi-agent`, `failure`, `real-tools`) were declared before anything filled them - switches with no wire behind them - and have been removed. They come back when they have steps.

The tour switches on `ls`, `list_agents`, `spawn_agent` and `dispose_agent` for its duration, added to whatever the person's own role already had. Reading and delegating, nothing that writes or executes.

## Explaining itself

Every act carries a `review` that says how the drill did what it just did - `registerProvider` for the model, `registerProfile` for the helper's role, `registerShortcut` for the advance key, the editor capability for the line in the editor, the chat capability for the narration itself. `narrate` is what is about to happen; `review` is how it was done.

That is not decoration either. drill is an extension, and the thing a new user most needs to come away believing is that they could write one too.

## The closing table

Counted, never written down. A hand-written "what WIDI can do" starts lying within months; a table built from what the run actually drove stays honest, and it grows a row by itself when core grows an observed event. The event column is checked against core's own exhaustive list, which is what makes "this never fired" a fact rather than an omission.
