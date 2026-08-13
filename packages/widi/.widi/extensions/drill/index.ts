import type { ExtensionDefinition } from "../../../apps/widi/src/core/extension/api.ts";
import type { TuiExtensionModule } from "../../../apps/widi/src/tui/extension-host/index.ts";
import { activateDrillCore } from "./core/index.ts";
import { activateDrillTui } from "./tui/index.ts";

/**
 * drill: a rehearsal of WIDI, run by WIDI.
 *
 * Two entry points, two hosts, one package. The default export is the core half
 * and is activated once per agent runtime; the `tui` named export is the TUI
 * half and is activated once for the whole application. Neither host sees the
 * other's module, so the two halves speak only over the extension event bus,
 * under the names in `protocol.ts`.
 *
 * Layout follows that split exactly:
 *
 *   protocol.ts   what the halves say to each other, and nothing else
 *   script/       the rehearsal itself, pure data, read by both halves
 *   core/         the half inside an agent: the model, the role, the sensors
 *   tui/          the half in the terminal: the director
 *
 * `core/` and `tui/` never import each other. That rule is the reason the
 * package can be read at all, so treat a first import across it as a bug.
 */
const extension: ExtensionDefinition = {
	apiVersion: 1,
	// One division, because one is what has steps behind it. The five developer
	// chapters the design sketched were switches with no wire attached; they come
	// back when there is something to switch.
	divisions: [{ id: "tour", label: "Guided tour" }],
	activate: async (api) => await activateDrillCore(api),
};

export const tui: TuiExtensionModule = { apiVersion: 1, activate: (api) => activateDrillTui(api) };

export default extension;
