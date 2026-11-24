#!/bin/sh
# Forces Claude Code's permission prompt for FeatureHub writes. In modes that never prompt
# (auto, dontAsk, bypassPermissions), Claude Code denies the call instead.
cat > /dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"FeatureHub write: confirm before it reaches the FeatureHub server."}}'
