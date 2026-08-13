#!/usr/bin/env bash
# WIDI installer: builds from this clone, installs the `widi` command as a
# ~/.local/bin shim, and seeds ~/.widi from preset/.
#
# Preset-managed files (profiles, themes) are overwritten on every run; state
# files (settings.json, agent/models.json, auth.json, trust.json, runs/) are
# seeded when missing and never touched afterwards. extensions/drill is a
# symlink into this clone: its sources import the app code by relative path,
# which only resolves when the files stay where they were written.
#
# Set WIDI_HOME to install the agent dir somewhere other than ~/.widi.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET_DIR="$REPO_ROOT/preset"
AGENT_DIR="${WIDI_HOME:-$HOME/.widi}"
BIN_DIR="$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
	echo "error: node not found; WIDI requires Node.js >= 22.19.0" >&2
	exit 1
fi
node -e 'const [maj, min] = process.versions.node.split(".").map(Number); if (maj < 22 || (maj === 22 && min < 19)) { console.error(`error: Node.js >= 22.19.0 required, found ${process.versions.node}`); process.exit(1); }'

cd "$REPO_ROOT"
echo "==> Installing dependencies"
npm ci
echo "==> Building"
npm run build

echo "==> Installing widi command to $BIN_DIR/widi"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/widi" <<EOF
#!/bin/sh
exec node "$REPO_ROOT/apps/widi/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/widi"
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) echo "note: $BIN_DIR is not on your PATH; add it to your shell profile" ;;
esac

echo "==> Seeding $AGENT_DIR from preset"
mkdir -p "$AGENT_DIR/profiles" "$AGENT_DIR/themes" "$AGENT_DIR/extensions" "$AGENT_DIR/agent"
cp -R "$PRESET_DIR/profiles/." "$AGENT_DIR/profiles/"
cp -R "$PRESET_DIR/themes/." "$AGENT_DIR/themes/"
rm -rf "$AGENT_DIR/extensions/drill"
ln -s "$PRESET_DIR/extensions/drill" "$AGENT_DIR/extensions/drill"
[ -f "$AGENT_DIR/settings.json" ] || cp "$PRESET_DIR/settings.json" "$AGENT_DIR/settings.json"
[ -f "$AGENT_DIR/agent/models.json" ] || cp "$PRESET_DIR/agent/models.json" "$AGENT_DIR/agent/models.json"

cat <<EOF

Done. Run \`widi\` from any directory.

The default model is kimi-coding/k3 (Kimi for Coding); log in from the TUI or
set MOONSHOT_API_KEY / ANTHROPIC_API_KEY for the moonshot and anthropic
providers defined in $AGENT_DIR/agent/models.json.
EOF
