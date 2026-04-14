/** Matches `screen_activity_narrator.NARRATOR_SYSTEM_PROMPT`. */
export const NARRATOR_SYSTEM_PROMPT =
  "You are a careful screen-activity narrator. Follow the output format exactly, including the KEY_FRAMES line.";

/** Matches `screen_activity_narrator.NARRATOR_USER_PROMPT_TEMPLATE` with {NUM_FRAMES}. */
export function buildNarratorUserPrompt(numFrames: number): string {
  return `You are a screen activity narrator. You describe what a user is doing on their
computer as a sequence of discrete actions. These descriptions are paired with
OCR text from key frames, so focus on actions and flow — not transcribing text.

You are looking at ${numFrames} sequential screenshots (numbered 1 through
${numFrames}) from a screen recording, evenly spaced.

Output a numbered list of actions. Each action should be one specific thing the
user did — a click, a switch, a scroll, typing, a copy-paste, etc. Quote short
identifying text (titles, labels, typed input, button names) but not full
paragraphs. Only describe actions that have visible evidence in the frames.

Example output format:
1. User has VS Code open with 'pipeline.test.ts' in the editor tab
2. Runs 'pnpm test' in the integrated terminal — output shows '3 passed, 1 failed'
3. Clicks the failing test name 'should retry on transient error' in terminal output
4. Editor jumps to 'pipeline.test.ts' line 89
5. Starts typing a mock setup but switches to Chrome before saving
6. Lands on GitHub PR '#142 Fix retry logic' — still in draft state

After your action list, on a new line, output exactly:
KEY_FRAMES: [i, j, ...]

where the list contains **between 5 and 10** distinct frame numbers (each from 1 to ${numFrames}).
Pick the frames with the most readable text for OCR extraction (fewer if the clip is very static).`;
}

/** Matches `daywiki_cleaned_ocr_temporal.VL_CLEAN_USER_PROMPT`. */
export const VL_CLEAN_USER_PROMPT = `Output the on-screen text verbatim, grouped into clear sections with short headings
(panel or role). Do not paraphrase or invent text.

Order sections by **importance**, not by left-to-right position on the image: put
**primary** surfaces **first** — main chat or assistant thread, editor body, terminal
output, or the focused document / modal — then **secondary** chrome **after** that:
sidebars (thread lists, recents, file trees), tab strips, toolbars, docks, menus, and
status bars. If a sidebar is on the left, still list it after the main panel unless the
screen is mainly about that sidebar.

Only output the formatted transcription; no preamble or commentary.`;

export const WIKI_JSON_USER_SUFFIX = `

Respond with a JSON **object** (first character \`{\`). Required keys: "operations" (array of wiki operations), "frame_decisions" (one object per labeled frame [frame 1], [frame 2], … in the batch: chunk_timestamp, frame_index integer, decision, target_page, reasoning). Optional: "batch_reasoning". If nothing to write, use {"operations": []} and still list frame_decisions with reasoning. Legacy: a bare JSON array of operations only is still accepted. No markdown fences or commentary outside JSON.`;
