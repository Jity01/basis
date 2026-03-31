"""
Sliding Window Video Tagger (Vision via Fireworks)
--------------------------------------------------
Same flow as sliding_window_gpt_mini.py, but uses Fireworks serverless vision models.

Usage: python sliding_window_llama_3.2_vision_with_fireworks.py <video_path> [--chunk-minutes 5] [--frames-per-chunk 15]

Default: 5 minutes of video per vision call.

Requires:
  - FIREWORKS_API_KEY in environment (or in a local .env)
  - pip install fireworks-ai python-dotenv opencv-python pillow
"""

import argparse
import base64
import json
import math
import os
from io import BytesIO

import cv2
from fireworks.client import Fireworks
from PIL import Image

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    # Keep script runnable even when python-dotenv is not installed.
    pass


def get_video_info(video_path: str) -> dict:
    cap = cv2.VideoCapture(video_path)
    info = {
        "fps": cap.get(cv2.CAP_PROP_FPS),
        "total_frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        "duration_sec": int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        / cap.get(cv2.CAP_PROP_FPS),
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    }
    cap.release()
    return info


def extract_frames(
    video_path: str,
    start_sec: float,
    end_sec: float,
    num_frames: int,
    max_dim: int = 1568,
) -> list:
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

            ratio = min(max_dim / img.width, max_dim / img.height)
            if ratio < 1:
                img = img.resize(
                    (int(img.width * ratio), int(img.height * ratio)),
                    Image.LANCZOS,
                )

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=80)
            frames_b64.append(base64.standard_b64encode(buf.getvalue()).decode("utf-8"))

    cap.release()
    return frames_b64


def format_time(seconds: float) -> str:
    m, s = int(seconds) // 60, int(seconds) % 60
    return f"{m:02d}:{s:02d}"


VISION_MODEL = os.environ.get(
    "FIREWORKS_MODEL",
    "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking",
)
FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"


def get_fireworks_client() -> Fireworks:
    api_key = os.environ.get("FIREWORKS_API_KEY")
    if not api_key:
        raise RuntimeError("FIREWORKS_API_KEY is not set")

    return Fireworks(
        api_key=api_key,
        base_url=FIREWORKS_BASE_URL,
    )


def analyze_chunk(
    client: Fireworks,
    frames_b64: list,
    start_sec: float,
    end_sec: float,
    rolling_context: str,
) -> str:
    """Send individual frames to Fireworks vision model and get a summary."""

    context_line = (
        f"Context from previous chunk: {rolling_context}\n\n" if rolling_context else ""
    )

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
- Briefly mention the platform the user is on if not already mentioned.

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

Write your summary as a single concise paragraph; do not be verbose. Keep your
analysis to the minimum and more so describe what's happening.

IMPORTANT: DO NOT REPEAT YOURSELF. If you've said something in the previous chunk,
don't say it again in this chunk summary. Focus only on what is new and different in
this chunk. If there absolutely aren't any new things, just do not say anything.
"""

    content: list = [
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{f}"}}
        for f in frames_b64
    ]
    content.append({"type": "text", "text": prompt})

    response = client.chat.completions.create(
        model=VISION_MODEL,
        messages=[{"role": "user", "content": content}],
    )

    t = response.choices[0].message.content
    if not t:
        raise RuntimeError("Empty response from Fireworks vision model")
    return t.strip()


def final_summary(client: Fireworks, chunk_summaries: list) -> dict:
    """Produce final metadata from all chunk summaries."""

    summaries_text = "\n\n".join(
        f"Chunk {i + 1}: {s}" for i, s in enumerate(chunk_summaries)
    )

    prompt = f"""Here are sequential summaries of a screen recording session:

{summaries_text}

Produce a JSON object with:
- "activity_label": short label for the overall session
- "summary": 1-2 sentence overall summary
- "entities": list of key people, projects, tools, URLs mentioned
- "tags": list of searchable tags
- "mode": "active" or "passive" or "mixed"

Return ONLY valid JSON, no markdown fences or extra text."""

    try:
        response = client.chat.completions.create(
            model=VISION_MODEL,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
        )
    except Exception:
        response = client.chat.completions.create(
            model=VISION_MODEL,
            messages=[{"role": "user", "content": prompt}],
        )

    raw = (response.choices[0].message.content or "").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw_response": raw}


def main():
    parser = argparse.ArgumentParser(
        description="Tag a screen recording using a Fireworks serverless vision model"
    )
    parser.add_argument("video", help="Path to video file (.mp4, .mov, .webm, ...)")
    parser.add_argument(
        "--chunk-minutes",
        type=int,
        default=5,
        help="Minutes of video per vision API call (default 5).",
    )
    parser.add_argument("--frames-per-chunk", type=int, default=15)
    parser.add_argument("--output", default="metadata_fireworks_vision.json")
    args = parser.parse_args()

    chunk_sec = args.chunk_minutes * 60
    client = get_fireworks_client()
    info = get_video_info(args.video)
    duration = info["duration_sec"]
    print(f"Video: {args.video}")
    print(f"Model: {VISION_MODEL}")
    print(f"Fireworks base URL: {FIREWORKS_BASE_URL}")
    print(
        f"Duration: {format_time(duration)} | {info['width']}x{info['height']} | {info['fps']:.1f}fps"
    )

    num_chunks = math.ceil(duration / chunk_sec)
    print(f"Processing {num_chunks} chunks of {args.chunk_minutes} min\n")

    rolling_context = ""
    chunk_summaries = []

    for i in range(num_chunks):
        start = i * chunk_sec
        end = min((i + 1) * chunk_sec, duration)
        print(f"Chunk {i + 1}/{num_chunks} [{format_time(start)} - {format_time(end)}]")

        frames = extract_frames(args.video, start, end, args.frames_per_chunk)
        print(f"  {len(frames)} frames extracted, sending to {VISION_MODEL}...")

        summary = analyze_chunk(client, frames, start, end, rolling_context)
        print(f"  Done: {summary}\n")

        chunk_summaries.append(summary)
        rolling_context = summary

    print("Final summary pass...")
    metadata = final_summary(client, chunk_summaries)
    metadata["chunk_summaries"] = chunk_summaries
    metadata["video_info"] = info
    metadata["video_path"] = args.video
    metadata["model"] = VISION_MODEL

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nSaved to {args.output}")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
