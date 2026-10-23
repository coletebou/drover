#!/usr/bin/env bash
# Start one Opus orchestrator Claude Code window per feature via the Drover launch op (the credential pool picks the
# token; tmux session "native"; profile DROVER_LAUNCH_PROFILE, default claude-yolo). usage: script/launch-windows.sh [name...]
set -euo pipefail
cd "$(dirname "$0")/.."
ALL=(00-core 01-macos-app 02-menubar 03-ios-app 04-watchos 05-widgets 06-chrome 07-safari)
SEL=("${@:-${ALL[@]}}")
for b in "${SEL[@]}"; do
  [ -f "briefs/$b.md" ] || { echo "no brief $b" >&2; exit 2; }
  prompt="You are the Opus orchestrator for window $b of Drover native. Read briefs/COMMON.md, CONTRACT.md and briefs/$b.md in $PWD, then execute the brief end to end (parallel Sonnet workers in git worktrees, verify their work yourself, cross-model review with codex, merge to local master, final report). Do not ask questions; decide and proceed."
  body=$(python3 -c 'import json,sys;print(json.dumps({"engine":"claude","mode":"tmux","profile":sys.argv[4],"model":"opus","cwd":sys.argv[1],"prompt":sys.argv[2],"tmuxSession":"native","name":"native-"+sys.argv[3],"credential":"auto","actor":"claude"}))' "$PWD" "$prompt" "$b" "${DROVER_LAUNCH_PROFILE:-claude-yolo}")
  drover op launch.start "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ok",True) and "launched" or d)' || true
  echo "$b started"; sleep 20
done
