#!/bin/bash
set -euo pipefail

# Install Playwright package and chromium browser
[ -f package.json ] || npm init -y
grep -qE "\"@playwright/test\"|\"playwright\"" package.json 2>/dev/null || npm install --save-dev @playwright/test
npx playwright install chromium

# Clone or update a local copy of Groundwork for reference (agent bench, ROSTER.md).
# Coda reads/writes the bench directly via `gh api` — this clone isn't required
# for that, it's just handy to have on disk inside the container.
if [ -d "$HOME/groundwork/.git" ]; then
  git -C "$HOME/groundwork" pull --ff-only --quiet 2>/dev/null || true
else
  git clone --quiet https://github.com/JacobGiordano/groundwork.git "$HOME/groundwork" 2>/dev/null || true
fi
[ -f "$HOME/groundwork/groundwork.sh" ] && echo "Groundwork ready at ~/groundwork/groundwork.sh" || echo "Groundwork clone skipped (check network or auth)"

# Seed Claude Code user settings (written on every rebuild — postCreateCommand always runs)
mkdir -p /home/node/.claude
cat > /home/node/.claude/settings.json << 'CLAUDESETTINGS'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "[ ! -f /tmp/claude-prompt-start ] && date +%s > /tmp/claude-prompt-start || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "start=$(cat /tmp/claude-prompt-start 2>/dev/null || echo 0); elapsed=$(( $(date +%s) - start )); [ $elapsed -gt 60 ] && rm -f /tmp/claude-prompt-start && curl -s -X POST -H 'Content-type: application/json' --data '{\"text\":\"Claude is done\"}' \"$SLACK_WEBHOOK_URL\" || true",
            "async": true
          }
        ]
      }
    ]
  },
  "tui": "fullscreen",
  "skipDangerousModePermissionPrompt": true,
  "theme": "auto",
  "remoteControlAtStartup": true,
  "agentPushNotifEnabled": true
}
CLAUDESETTINGS
echo "Claude Code user settings written"
