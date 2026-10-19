---
title: Genjutsu (motion transfer)
description: The core feature — pick a motion, pick a character, get the character performing the motion with Wan Animate 2.
---

The core feature of the app: an open rebuild of the motion-transfer half of Higgsfield Genjutsu. The user picks a driving video of one person (3–8 s), a character image, and gets that character performing the motion. Generation runs on **Wan Animate 2** (Apache-2.0) through the official ComfyUI `video_wan_animate2` template, called from the app through `@comfyorg/sdk`.

## What the user gets

1. **Pick a motion** — from the sample library, or upload a clip (trimmed to ≤ 8 s).
2. **Pick a character** — a sample, or an upload with a likeness-consent checkbox.
3. **Generate** — optional reshoot angle, appearance/background prompt, seed. Progress streams live.
4. **Compare** — source and result on one clock, with the source audio.
5. **Download / remix / share** — final MP4, "same motion, another character", a share page that unfurls with video.

## How it works

![Pipeline: browser, app container, Comfy](/pipeline.svg)

The browser only talks to the app; the app is the only thing that talks to Comfy. Steps 4–8 cross into the Comfy lane; step 5 (`buildGraph`) is pure data work in the middle. The yellow pills are the values the `status` column takes along the way.

Three rules hold the pipeline together:

- Persist the idempotency key **before** `submit()` and the provider job id **the instant** it returns. A lost id is an unrecoverable, already-paid job.
- `jobs.get()` is the source of truth. A timer never marks a job done.
- `finalize()` runs from both the SSE path and status reads, so a restart mid-job costs a progress bar, not a result.

## Build it

The feature is built in small, verified steps: see [Implementation steps](/features/genjutsu/implementation-steps/). Background decisions live in the project docs (`docs/tech-stack.md`, `docs/mvp-implementation-plan.md`, `docs/spike-verification-checklist.md`).
