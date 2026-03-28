"""
Sliding Window Video Tagger v2
-------------------------------
Sends individual frames (no contact sheet) to Claude for analysis.

Usage: python tag_video.py <video_path> [--chunk-minutes 5] [--frames-per-chunk 15]
"""

import cv2
import base64
import json
import math
import argparse
from io import BytesIO
from PIL import Image
import anthropic


def get_video_info(video_path: str) -> dict:
    cap = cv2.VideoCapture(video_path)
    info = {
        "fps": cap.get(cv2.CAP_PROP_FPS),
        "total_frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        "duration_sec": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) / cap.get(cv2.CAP_PROP_FPS),
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    }
    cap.release()
    return info


def extract_frames(video_path: str, start_sec: float, end_sec: float, num_frames: int, max_dim: int = 1568) -> list:
    """Extract evenly spaced frames, downscaled. Returns list of base64 JPEG strings."""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)

    timestamps = [
        start_sec + i * (end_sec - start_sec) / (num_frames - 1)
        for i in range(num_frames)
    ]

    frames_b64 = []
    for ts in timestamps:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(ts * fps))
        ret, frame = cap.read()
        if ret:
            img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

            # Downscale so longest edge <= max_dim
            ratio = min(max_dim / img.width, max_dim / img.height)
            if ratio < 1:
                img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=80)
            frames_b64.append(base64.standard_b64encode(buf.getvalue()).decode("utf-8"))

    cap.release()
    return frames_b64


def format_time(seconds: float) -> str:
    m, s = int(seconds) // 60, int(seconds) % 60
    return f"{m:02d}:{s:02d}"


def analyze_chunk(client, frames_b64: list, start_sec: float, end_sec: float, rolling_context: str) -> str:
    """Send individual frames to Claude and get a summary."""

    context_line = f"Context from previous chunk: {rolling_context}\n\n" if rolling_context else ""

    prompt = f"""You are a screen activity analyzer. Your job is to produce specific
summaries of what a user is doing on their computer. These summaries will be stored
and later searched by an AI agent to answer questions like "when did I work on X?"
or "what was I trying to figure out about Y?" — so specificity and detail matter.
 
You are looking at {len(frames_b64)} sequential screenshots from a screen recording,
covering {format_time(start_sec)} to {format_time(end_sec)}, evenly spaced.

{context_line}

INSTRUCTIONS:
- Read and understand the actual text on screen carefully. Do not just rely on
the visual layout.
- Focus on INTENT and CONTENT. What is the user trying to do?
  What are they thinking about? What problem are they solving?
- If the user is in a conversation (chat, email, etc.), summarize both sides.
- Name specific entities as needed.
 
GOOD SUMMARY EXAMPLE:
"User is writing a cold outreach email to a partner at Morrison & Foerster
about a new compliance monitoring product. They are iterating on the subject
line, testing variations that emphasize ROI for mid-size firms. They also
have a spreadsheet open tracking 30 law firms they plan to contact this week,
with columns for partner name, practice area, and outreach status. Three
firms are marked as already contacted: Baker McKenzie, Latham & Watkins,
and Sidley Austin."
 
BAD SUMMARY EXAMPLE:
"User is browsing code repositories and documentation in a web browser with
multiple tabs open. They appear to be doing development work with a dark-themed
IDE visible. The activity suggests active research and coding."
 
The bad example is useless because it describes what things look like, not what
the user is actually doing or thinking about. It contains zero searchable details.
 
Write your summary as a single detailed paragraph; do not be verbose.
"""

    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": f}}
        for f in frames_b64
    ]
    content.append({"type": "text", "text": prompt})

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1500,
        messages=[{"role": "user", "content": content}],
    )

    return response.content[0].text


def final_summary(client, chunk_summaries: list) -> dict:
    """Produce final metadata from all chunk summaries."""

    summaries_text = "\n\n".join(f"Chunk {i+1}: {s}" for i, s in enumerate(chunk_summaries))

    prompt = f"""Here are sequential summaries of a screen recording session:

{summaries_text}

Produce a JSON object with:
- "activity_label": short label for the overall session
- "summary": 1-2 sentence overall summary
- "entities": list of key people, projects, tools, URLs mentioned
- "tags": list of searchable tags
- "mode": "active" or "passive" or "mixed"

Return ONLY valid JSON, no markdown fences or extra text."""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw_response": raw}


def main():
    parser = argparse.ArgumentParser(description="Tag a screen recording using Claude vision")
    parser.add_argument("video", help="Path to video file (.mp4 or .mov)")
    parser.add_argument("--chunk-minutes", type=int, default=5)
    parser.add_argument("--frames-per-chunk", type=int, default=15)
    parser.add_argument("--output", default="metadata.json")
    args = parser.parse_args()

    chunk_sec = args.chunk_minutes * 60
    client = anthropic.Anthropic()

    info = get_video_info(args.video)
    duration = info["duration_sec"]
    print(f"Video: {args.video}")
    print(f"Duration: {format_time(duration)} | {info['width']}x{info['height']} | {info['fps']:.1f}fps")

    num_chunks = math.ceil(duration / chunk_sec)
    print(f"Processing {num_chunks} chunks of {args.chunk_minutes} min\n")

    rolling_context = ""
    chunk_summaries = []

    for i in range(num_chunks):
        start = i * chunk_sec
        end = min((i + 1) * chunk_sec, duration)
        print(f"Chunk {i+1}/{num_chunks} [{format_time(start)} - {format_time(end)}]")

        frames = extract_frames(args.video, start, end, args.frames_per_chunk)
        print(f"  {len(frames)} frames extracted, sending to Claude...")

        summary = analyze_chunk(client, frames, start, end, rolling_context)
        print(f"  Done: {summary[:120]}...\n")

        chunk_summaries.append(summary)
        rolling_context = summary

    print("Final summary pass...")
    metadata = final_summary(client, chunk_summaries)
    metadata["chunk_summaries"] = chunk_summaries
    metadata["video_info"] = info
    metadata["video_path"] = args.video

    with open(args.output, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nSaved to {args.output}")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()