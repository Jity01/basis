---
name: context-trigger
description: "Fetches the user's screen activity context from Basis. Use whenever the user (a) types the shortcut 'ct' anywhere in a message, (b) asks about their own work, projects, communications, or decisions ('what was I doing', 'help me continue', 'what did I say about X'), (c) references something not shown in chat ('this', 'that email', 'the bug I was looking at', 'help me with this'), or (d) asks any question where answering well would require knowing what they've been doing. Call get_context FIRST (always, ~300 tokens), then use search_by_topic / search_by_app / search_by_entity for targeted lookup, or get_latest_snapshots for what's on screen right now. Do NOT ask 'what context do you want' — just fetch it."
---

# Basis Context

## When to use this skill

Fetch context from Basis in any of these situations:

**Explicit triggers:**
- User types `ct` alone or anywhere in a message — this is a shortcut meaning "get my context"

**Implicit triggers:**
- User asks about their own work, projects, communications, or recent decisions
- User says "help me continue", "what was I doing", "pick up where I left off", "remind me"
- User references "this", "that", "it" when nothing has been shown in chat (they're gesturing at their screen)
- User asks for help with something that would require them to re-explain context they've already built elsewhere — emails, bugs, PRs, documents, conversations
- Any question where guessing would force the user to repeat themselves

**Rule of thumb:** if you're about to ask "what are you working on?" or "can you give me more context?" — stop and fetch it instead.

## Behavior

1. **ALWAYS call `get_context` FIRST.** It's cheap (~300 tokens) and gives you active projects, recent threads, last session, and daily patterns. This is your baseline awareness — always do this before the rest.

2. **Targeted search (when you know what you're looking for):**
   - `search_by_topic("react", dateFrom: "...")` — find work on a topic
   - `search_by_app("VS Code")` — find sessions using a specific app
   - `search_by_entity("AuthProvider")` — find chunks mentioning a file, URL, person, or project

3. **Structured day browsing:**
   - `get_sessions("2026-04-08")` — activity grouped into meaningful sessions
   - `get_day_catalog("2026-04-08")` — structured metadata for every chunk

4. **Raw prose / visual detail:**
   - `list_days` + `get_day_index` — concatenated prose summaries
   - `get_chunk_context("2026-04-08/14-30")` — full chunk with summary + 5 screenshots

5. **What's on screen RIGHT NOW:**
   - `get_latest_snapshots` — last 2 screenshots + OCR
   - `get_live_context` — OCR text timeline of the last 30-60s
   - `get_live_frame(timestamp)` — single screenshot by timestamp

Do this BEFORE responding substantively. Multiple rounds of lookup are often needed — one question frequently requires crossing days and topics.

## Examples

User: "ct"
→ Call `get_context`, report what they've been doing recently.

User: "help me continue what I was doing"
→ Call `get_context`, find the most recent session, use `get_sessions` to reconstruct the thread, then help them continue.

User: "what did I say about the auth fix yesterday?"
→ Call `get_context`, then `search_by_topic("auth")` filtered to yesterday, drill into matching chunks with `get_chunk_context`.

User: "look at this" (nothing shown in chat)
→ Call `get_latest_snapshots` to see what they're looking at right now.

User: "help me respond to Caleb's email about onboarding"
→ Call `get_context`, then `search_by_entity("Caleb")` and `search_by_topic("onboarding")`, pull relevant chunks to see the email content and their prior work.

## Do NOT

- Ask "what context do you want?" — just fetch it
- Guess what they were doing — look it up
- Skip `get_context` — it's always the first call
- Wait for the user to explicitly say `ct` — implicit requests count too
- Stop after one tool call — often multiple rounds are needed
