---
name: context-trigger
description: "IMMEDIATE TRIGGER: When the user types 'ct' (alone or in a message), this means 'get my context' — immediately call the user-context MCP tools to see what they were doing on their screen. Do NOT ask clarifying questions. Do NOT guess. Call user-context:list_days first, then drill into relevant days/chunks. This is a shortcut command — treat 'ct' as an explicit instruction to fetch screen activity context."
---

# Context Trigger

## What this skill does

When the user types **ct** anywhere in their message, it's a shortcut command meaning: "I need you to know what I was doing — go check my screen activity."

## Behavior

1. **Immediately call** `user-context:list_days` to see available days
2. **Then call** `user-context:get_day_index` for the most recent/relevant day
3. **Then call** `user-context:get_chunk_context` if you need specific details

Do this BEFORE responding substantively. The user is telling you they want context-aware assistance.

## Why this exists

The user-context MCP has screen recordings indexed by day and time chunk. But Claude often doesn't think to use it. This skill creates an explicit trigger: "ct" = go get context.

## Examples

User: "ct"
→ Call list_days, then get_day_index for today, summarize what they were working on

User: "ct help me continue what I was doing"
→ Call the tools, find recent activity, then help them continue

User: "I was working on something earlier ct"
→ Call the tools to find what they were working on

## Do NOT

- Ask "what context do you want?" — just fetch it
- Guess what they were doing — look it up
- Ignore the "ct" — it's an explicit command
