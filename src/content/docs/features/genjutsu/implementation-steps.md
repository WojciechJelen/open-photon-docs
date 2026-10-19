---
title: Implementation steps
description: Baby-step build plan for the motion-transfer feature. Every step has a verification section; do not start the next step until the current one is verified.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 3
---

This is the build order for the Genjutsu (motion transfer) feature, from the verified spike (`comfy-start-spike`, commit `308d20b`) to a submittable app. It is written for one developer working alone, in the order the pieces depend on each other.

**How to use this page**

- Work top to bottom. Each step is small enough to finish in one sitting (30 min – half a day).
- Every step ends with a **Verify** section. Run it. If anything is red, fix it before moving on; do not stack unverified work.
- When a step is verified, commit with the message `step N.M: <title>` and tick it in `CHECKLIST.md` at the repo root. That file becomes the evidence trail a judge (or a future you) can read.
- Steps marked 💸 create **one paid Comfy Cloud job**. Nothing else on this page costs credits. If an unmarked step ever returns `201` from the submit path, stop and check the Comfy queue.
- Never print `.env`. Commands read it through `--env-file` or the process environment only.

## The pipeline you are building

![Pipeline: browser, app container, Comfy](/pipeline.svg)

The browser only talks to the app; the app is the only thing that talks to Comfy. Steps 4–8 in the picture cross into the Comfy lane; step 5 (`buildGraph`) is pure data work in the middle. The yellow pills are the values the `status` column takes along the way: `preparing → queued → running → finalizing → done | failed`.

Three rules that every step below respects:

1. Persist the idempotency key **before** `submit()` and the provider job id **the instant** it returns.
2. `jobs.get()` is the source of truth; a timer never marks a job done.
3. `finalize()` runs from both the SSE path and status reads, under an in-process lock.

Source documents: `docs/mvp-implementation-plan.md` (scope, data model, milestones), `docs/tech-stack.md` (why each choice), `docs/spike-verification-checklist.md` and `docs/independent-verification-report.md` (what the spike proved and what it left open), `docs/spike-test.md` (the full re-test procedure).

---

## Phase 0 — Before writing code

### Step 0.1 — Toolchain preconditions

**Goal:** the machine can build, test and run everything the later steps need.

**Do:** install or update whatever the table says is missing.

| Need | Why |
|---|---|
| Node ≥ 24 | `node:sqlite` is built in; the image uses 24.19 |
| npm ≥ 11 | npm 10 fails `npm ci` on the spike lockfile (`lru-cache@11.5.3`) |
| Docker with buildx (Colima or Docker Desktop) | amd64 image builds |
| ffmpeg + ffprobe | trim, probe, poster frames |
| Playwright Chromium | e2e suite |
| `COMFY_API_KEY` in `.env` | every paid step |

**Verify**

```sh
node --version          # v24.x
npm --version           # 11.x
docker buildx version   # prints a version
ffmpeg -version | head -1 && ffprobe -version | head -1
npx playwright install chromium
grep -c '^COMFY_API_KEY=' .env    # 1 — never cat the file
```

Write the current Comfy credit balance into `CHECKLIST.md` under "credits before build". You will subtract from it later.

**Done when:** every command above prints the expected value.

### Step 0.2 — The spike is green in a clean copy

**Goal:** confirm the starting point actually passes before you build on it. A stale `node_modules` can hide a broken lockfile.

**Do:** copy the spike without `node_modules`, `.git`, `work`, `data`, `.output`, `.env*` and run the static suite there (this is Stage 0 of `docs/spike-test.md`).

```sh
cd ~/workspace/comfy-start-spike
rm -rf /tmp/spike-clean && rsync -a --exclude node_modules --exclude .git --exclude work \
  --exclude data --exclude .output --exclude '.env*' ./ /tmp/spike-clean/
cd /tmp/spike-clean
npm ci
npm run typecheck
npm run check
npm run test:server
COMFY_API_KEY=dummy-key npm run build
npm run check:client
```

**Verify**

- `npm ci` exit 0 (on npm 11).
- `typecheck` exit 0 and `diff -q src/routeTree.gen.ts ~/workspace/comfy-start-spike/src/routeTree.gen.ts` prints nothing.
- Biome: "no fixes".
- Server tests: `pass 12`, `fail 0`.
- Build exit 0; `check:client` reports zero matches; `grep -rl dummy-key .output/` finds nothing.

**Done when:** all five are green. If any is red, you have found a problem in the spike — fix it there first and re-run.

---

## Phase 1 — The workflow as data

### Step 1.1 — Create the real repo from the spike

**Goal:** a clean repository that will become the submission, with CI from the first commit.

**Do:**

1. `mkdir ~/workspace/<app-name> && cd $_` (working name until the trademark check; the docs say "the app").
2. Copy the spike tree minus `node_modules`, `.git`, `work`, `data`, `.output`, `.env`. Keep `.env.example`.
3. `git init`, add `LICENSE` (MIT or Apache-2.0 — decide now, the rules require it), `README.md` with one paragraph and the `cp .env.example .env && docker compose up` line, and an empty `CHECKLIST.md`.
4. Add `.github/workflows/ci.yml` running: `npm ci`, `npm run typecheck`, `npm run check`, `npm run test:server`, `COMFY_API_KEY=ci-canary npm run build`, `npm run check:client`.
5. Commit, push to a **public** GitHub repo (public from day one is part of the viral-category evidence trail).

**Verify**

```sh
git log --oneline | wc -l            # 1
git ls-files | grep -c '^\.env$'      # 0
git check-ignore -v .env             # .gitignore matches
gh run list --limit 1                 # CI: completed, success
```

**Done when:** CI is green on the first commit and `.env` is ignored.

### Step 1.2 — Apply the audit's one-line fixes

**Goal:** close the cheap items the independent audit flagged (D5, D6, D11) before the codebase grows.

**Do:**

- `package.json`: add `"packageManager": "npm@11.x.y"` (your installed version).
- `compose.yaml`: remove `ENABLE_SPIKE_CHECKS: "1"`; add `platform: linux/amd64` under the service.
- `tests/studio.spec.ts`: in the whitespace-validation case, assert that **no** `POST /api/jobs` fires (`page.waitForRequest(..., { timeout: 1500 })` wrapped so that a rejection is the pass). Today that test clicks "Render on Comfy"; a validation regression would submit a paid job.

**Verify**

```sh
grep -c packageManager package.json             # 1
grep -c ENABLE_SPIKE_CHECKS compose.yaml        # 0
grep -c 'platform: linux/amd64' compose.yaml    # 1
npm run typecheck && npm run check
```

Temporarily break the whitespace validation (make it accept `"   "`), run `WAN_TEST_JOB_ID=<spike id> npm run test:e2e` with the Comfy base URL pointed at a dead port, and confirm the e2e test **fails** on "unexpected POST /api/jobs". Restore the validation; the test passes again.

**Done when:** the negative-control run fails and the restored run passes. Commit.

### Step 1.3 — Promote the workflow file to v1 and drop node 292

**Goal:** `workflows/motion-transfer.v1.json` — the executable graph the app will submit, with the comparison branch removed.

**Do:**

1. Copy `workflows/wan-animate-2/workflow-api.json` to `workflows/motion-transfer.v1.json`.
2. **Trace node `292` before deleting it.** Follow its `inputs` back: it must lead through `ImageStitch` to the same frames `246` saves. If it does, delete `292` and any node that is now reachable from no output (ComfyUI would skip them anyway; removing them keeps the file honest). If it does not, stop and read what it is.
3. Write `workflows/README.md`: where the template came from (official `video_wan_animate2`, upstream commit, MIT license file), what was changed (292 dropped and why), and a table with the SHA-256 of `motion-transfer.v1.json`.

**Verify**

```sh
node -e '
const g=require("./workflows/motion-transfer.v1.json");
const ids=Object.keys(g);
console.log("nodes", ids.length, "has292", "292" in g);
const types=[...new Set(ids.map(i=>g[i].class_type))].sort();
console.log("WanAnimate2ToVideo", types.includes("WanAnimate2ToVideo"));
console.log("forbidden", types.filter(t=>/Higgsfield|Api|API|Kling|Veo|Gemini|Runway|Luma|MiniMax|LTX/.test(t)));
// every reference points at an existing node
let dangling=0;
for (const n of Object.values(g)) for (const v of Object.values(n.inputs))
  if (Array.isArray(v) && !(v[0] in g)) dangling++;
console.log("dangling refs", dangling);
'
sha256sum workflows/motion-transfer.v1.json      # equals the README table
```

Expect: `has292 false`, `WanAnimate2ToVideo true`, `forbidden []`, `dangling refs 0`, node count 63 or fewer (64 minus 292 minus any orphans you removed).

**Done when:** the script output matches and the README hash is correct. Commit.

### Step 1.4 — The inputs map

**Goal:** `workflows/motion-transfer.v1.inputs.json` — the only place that knows which node and field each app parameter patches.

**Do:** open the v1 JSON and find, by hand, the `node_id.field` for each exposed parameter from the plan (§6):

| Param | Where to look |
|---|---|
| `driving_video` | `LoadVideo` (`240`), its file field |
| `reference_image` | `LoadImage` (`189`), its image field |
| `prompt` | the positive `CLIPTextEncode` (the one wired to the positive conditioning) |
| `seed` | the sampler's noise seed (`SamplerCustom` or a `PrimitiveInt` feeding it) |
| `width`, `height` | `WanAnimate2ToVideo` |
| `frames` / `length` | `WanAnimate2ToVideo` |

Write the map in this shape, with the expected `class_type` so the map can check itself:

```json
{
  "workflow": "motion-transfer.v1.json",
  "inputs": {
    "driving_video":   { "node": "240", "field": "file",  "class_type": "LoadVideo" },
    "reference_image": { "node": "189", "field": "image", "class_type": "LoadImage" },
    "prompt":          { "node": "<id>", "field": "text", "class_type": "CLIPTextEncode" },
    "seed":            { "node": "<id>", "field": "<field>", "class_type": "<type>" },
    "width":           { "node": "<id>", "field": "width",  "class_type": "WanAnimate2ToVideo" },
    "height":          { "node": "<id>", "field": "height", "class_type": "WanAnimate2ToVideo" },
    "frames":          { "node": "<id>", "field": "length", "class_type": "WanAnimate2ToVideo" }
  }
}
```

The `angle` parameter is **not** a node field: it is a prompt fragment appended by the app (`workflows/angles.json` arrives in Step 5.3). Record that in the map's README line so nobody looks for it.

**Verify**

```sh
node -e '
const g=require("./workflows/motion-transfer.v1.json");
const m=require("./workflows/motion-transfer.v1.inputs.json");
let bad=0;
for (const [k,v] of Object.entries(m.inputs)) {
  const n=g[v.node];
  const ok = n && n.class_type===v.class_type && v.field in n.inputs && !Array.isArray(n.inputs[v.field]);
  console.log(ok?"ok ":"BAD", k, "->", v.node+"."+v.field, n?n.class_type:"(missing)", ok?JSON.stringify(n.inputs[v.field]):"");
  if(!ok) bad++;
}
process.exit(bad?1:0);
'
```

Every line must be `ok`, and the printed current value must be a **literal** (a filename, number or string), never a `[node, index]` reference. If a field is a reference, you picked a field that is wired from another node — follow the wire and map that node instead.

**Done when:** exit code 0. Commit.

### Step 1.5 — `buildGraph` and its tests

**Goal:** a pure, typed function that turns (template, map, params) into a submittable graph. No SDK, no file I/O.

**Do:** create `src/server/workflows/`:

- `params.ts` — zod schema: `driving_video` and `reference_image` as strings (provider filenames), `prompt` string, `seed` integer, `width`/`height` positive integers, `frames` positive integer.
- `build-graph.ts` — `buildGraph(template, inputsMap, params)`: structured-clone the template, for each map entry set `graph[node].inputs[field] = params[key]`, return the clone. Throw if a mapped node or field is missing.
- `registry.ts` — `loadWorkflow("motion-transfer", 1)` returning `{ graph, inputsMap, sha256 }` read from `workflows/`.
- `tests/build-graph.test.ts` (node --test):
  1. **Fixture reproduction.** Add `WAN_DRY_RUN=1` to the spike's `run-wan.mjs` so it writes the exact graph it would submit to `tests/fixtures/spike-submitted-graph.json` (one-off, no job). Assert `buildGraph(template, map, fixtureParams)` deep-equals that file, ignoring `292` if the fixture still has it.
  2. **One param, one field.** Change only `seed`; assert exactly one leaf differs from case 1.
  3. **Immutability.** The template object is unchanged after the call.
  4. **Bad map.** A map entry pointing at a missing node throws.
  5. **Bad params.** `frames: 0` or a non-integer seed is rejected by the schema.

**Verify**

```sh
npm run test:server           # 17 pass (12 + 5), 0 fail
npm run typecheck && npm run check
grep -rn "from '@comfyorg\|node:fs" src/server/workflows/build-graph.ts   # nothing
```

**Done when:** tests green and `build-graph.ts` imports neither the SDK nor fs. Commit. This is the step everything else fans out from.

### Step 1.6 — 💸 First parameter-driven render, and the credit cost

**Goal:** prove the registry path end to end on Comfy Cloud, and measure credits per render (open item C3).

**Do:** write `scripts/render-once.mjs` that takes a params JSON, calls `loadWorkflow` + `buildGraph`, uploads the two fixture files through the SDK (content-addressed, the second upload is free), submits with an idempotency key, follows events, downloads the output into `work/`. Run it once with a **non-fixture seed and a changed prompt** so the output visibly differs from the Oct 18 render.

```sh
echo "credits_before=$(read from Comfy billing)" >> CHECKLIST.md
node scripts/render-once.mjs params/first-registry-render.json 2>&1 | tee work/step-1.6.log
echo "credits_after=$(read from Comfy billing)" >> CHECKLIST.md
```

**Verify**

- Log shows one submit, one job id, events `running … complete`, one download.
- `ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames -of json work/<out>.mp4`: `h264`, `480×848`, 121 frames (or whatever `frames` you passed), plus an `aac` stream.
- The output's SHA-256 differs from the Oct 18 render (`e482c4c6…9040a`).
- Run the script **again with the same params file**: no new job is created (idempotency key rejects it, or your script resumes). Check the Comfy queue shows one job, not two.
- `credits_after − credits_before` is written into `CHECKLIST.md` and into `README.md` as "credits per 5 s 480×848 render (base/distilled)".

**Done when:** one paid job, a visibly different output, and a number for C3. Commit the script and the params file (never the output).

---

## Phase 2 — Durable state

### Step 2.1 — One connection, WAL, a migrations table

**Goal:** the SQLite layer the real schema can grow on. The spike opens a new connection per operation and re-runs `CREATE TABLE`; fix that now.

**Do:** in `src/server/db.server.ts`:

- Open one `DatabaseSync` at module load; `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON`.
- Add a `migrations` table and `migrate()` that applies numbered SQL files from `src/server/migrations/` once. Migration `001` creates `assets` and `generations` as in the plan's §7 (keep the spike's `jobs` table for now; drop it in Step 4.1).
- Keep zod validation on every read of a JSON column.

**Verify**

```sh
npm run test:server
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.DB_PATH||"data/app.sqlite");
console.log(db.prepare("PRAGMA journal_mode").get());          // { journal_mode: "wal" }
console.log(db.prepare("select name from sqlite_master where type=\"table\"").all().map(r=>r.name));
console.log(db.prepare("select * from migrations").all());
'
```

Expect `wal`, tables `migrations, assets, generations` (plus the old `jobs`), and one migration row. Run the app twice; the migration row count stays 1.

**Done when:** WAL is on, the connection is a singleton (grep `new DatabaseSync` → one hit), migrations are idempotent. Commit.

### Step 2.2 — Recipes, `recipe_hash`, idempotency, child rows

**Goal:** the generation row design the whole product relies on, tested without Comfy.

**Do:**

- `src/server/recipe.ts`: zod `Recipe` = `{ workflow: {id, version, sha256}, models: [...from models.lock placeholder], params, inputs: { driving_video_sha256, reference_image_sha256 }, target: "cloud" | "selfhost" }`. `recipeHash(recipe)` = SHA-256 of canonical JSON (sorted keys, no timestamps).
- `src/server/generations.ts`: `createGeneration({recipe, parentId?})` inserts with `status: "preparing"`, a fresh `idempotency_key`, `recipe_hash`; `findReusable(recipeHash)` returns a `done` row with the same hash; `markQueued(id, providerJobId)`; `transition(id, from, to)` enforcing the state machine; `markUnknown(id)` for the crash window.
- Tests:
  1. Same params → same `recipe_hash`; any one param changed → different hash; key order in the input object does not matter.
  2. `createGeneration` persists `idempotency_key` before any provider call (assert the row exists with `provider_job_id IS NULL`).
  3. `transition` rejects `done → running` and `queued → done`.
  4. `findReusable` returns the row only when `status = done`.
  5. A child row keeps `parent_id` and gets a new `idempotency_key`.

**Verify**

```sh
npm run test:server          # all green, five new cases
```

**Done when:** tests green. Commit.

---

## Phase 3 — Getting inputs in

### Step 3.1 — Upload route stores an asset

**Goal:** `POST /api/uploads` streams a file to disk, hashes it, and returns an `assets` row. Reuse the spike's busboy route (128 MiB limit, 413 before writing).

**Do:** on completion, compute SHA-256 while streaming, move the temp file to `data/assets/<sha256>.<ext>`, insert into `assets` (`kind`, `role: "upload"`, `mime`, `bytes`); if the hash already exists, delete the temp file and return the existing row (content-addressed dedupe).

**Verify**

```sh
curl -s -F file=@fixtures/wan/driving.mp4 localhost:3030/api/uploads | tee /tmp/u1.json   # 201, {id, sha256, bytes}
curl -s -F file=@fixtures/wan/driving.mp4 localhost:3030/api/uploads | tee /tmp/u2.json   # 200, same id
diff <(jq .id /tmp/u1.json) <(jq .id /tmp/u2.json) && echo deduped
ls data/assets | wc -l                                                                    # 1
head -c 129000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -F file=@- localhost:3030/api/uploads   # 413
```

**Done when:** dedupe works and the 413 path still rejects before writing. Commit.

### Step 3.2 — Probe and trim with FFmpeg

**Goal:** every uploaded video is probed; too-long clips are trimmed to ≤ 8 s; bad files are rejected with a reason.

**Do:** `src/server/media/probe.ts` (spawn `ffprobe -print_format json -show_streams -show_format`), `src/server/media/trim.ts` (spawn `ffmpeg -ss <start> -t <len> -c copy` when possible, re-encode when the cut lands off a keyframe). Rules: no video stream → `reject:no_video`; duration < 3 s → `reject:too_short`; > 8 s → create a `trimmed` asset (video **and** audio, so the passthrough audio stays in sync); fill `width`, `height`, `duration_ms`, `fps`, `has_audio` on the row.

**Verify**

```sh
# make three fixtures once (keep them in tests/fixtures)
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=24 -f lavfi -i sine=duration=2 tests/fixtures/short-2s.mp4
ffmpeg -y -f lavfi -i testsrc=duration=12:size=320x240:rate=24 -f lavfi -i sine=duration=12 tests/fixtures/long-12s.mp4
ffmpeg -y -f lavfi -i sine=duration=5 tests/fixtures/audio-only.m4a
npm run test:server          # new cases: too_short, no_video, trim-to-8s keeps audio, has_audio=false on a silent clip
```

Add the unit cases: trimmed duration between 7.9 and 8.0 s; trimmed file still has an `aac` stream; probe of `audio-only.m4a` → `no_video`.

**Done when:** tests green and a real 12 s phone clip uploaded through the route comes back as an 8 s trimmed asset. Commit.

### Step 3.3 — Characters: samples and uploads with consent

**Goal:** the `characters` table and the two ways to get one.

**Do:** migration `002` adds `characters` (§7). `POST /api/characters` accepts an image upload plus `consent: true` (reject without it, 422). `samples/characters/` holds 2–3 placeholder PNGs for now (replaced by Klein-generated ones in Step 9.1) with a `manifest.json`; a seed script inserts them with `is_sample = 1` and `origin = "generated"`.

**Verify**

```sh
curl -s -o /dev/null -w '%{http_code}\n' -F image=@fixtures/wan/reference.png localhost:3030/api/characters                 # 422 (no consent)
curl -s -F image=@fixtures/wan/reference.png -F consent=true localhost:3030/api/characters | jq '{id, consent_at}'          # consent_at set
node scripts/seed-samples.mjs && sqlite3 data/app.sqlite 'select count(*) from characters where is_sample=1'                # 3
```

**Done when:** consent is enforced and samples are seeded idempotently (run the seed twice; still 3). Commit.

---

## Phase 4 — Generate

### Step 4.1 — The `generate` server function 💸

**Goal:** one typed RPC that takes `{motion_id | upload_asset_id, character_id, prompt?, angle?, seed?}` and returns a generation id, having done steps 3 → 6 of the pipeline in order.

**Do:** `src/lib/generate.functions.ts` (TanStack server function, zod-validated input) calling `src/server/generate.ts`:

1. Resolve assets; refuse if the motion asset is not probed or the character has no consent.
2. Build the recipe, compute `recipe_hash`; if `findReusable` hits, return that id (no job).
3. `createGeneration` → row with `preparing` and a persisted `idempotency_key`.
4. Upload both files to Comfy (content-addressed; keep the returned names on the row in a `provider_inputs` JSON column).
5. `buildGraph` → `submit(graph, { idempotencyKey })`.
6. `markQueued(id, providerJobId)` **immediately**. If the process dies between 5 and 6, the row is `unknown` on next read and is never resubmitted.

Delete the spike's `jobs` table and its routes in this step; `generations` replaces it.

**Verify**

Run with Comfy pointed at a **dead port** first:

```sh
COMFY_BASE_URL=http://127.0.0.1:1 npm run dev
# call generate from the browser dev tools or a tiny script
sqlite3 data/app.sqlite 'select id,status,idempotency_key,provider_job_id,error_code from generations order by created_at desc limit 1'
```

Expect a row with a non-null `idempotency_key`, `provider_job_id` NULL, `status = failed`, `error_code` describing the connection error — this proves ordering rule 1 without spending anything.

Then one paid run against Cloud:

```sh
echo "credits_before=…" >> CHECKLIST.md
# call generate with a sample motion + sample character + a new seed
sqlite3 data/app.sqlite 'select status,provider_job_id from generations order by created_at desc limit 1'   # queued, a7…-style id
# call generate again with the exact same inputs and seed
sqlite3 data/app.sqlite 'select count(*) from generations'   # unchanged — reused, no second job
```

**Done when:** the dead-port run leaves a correct failed row, the live run leaves a queued row with a job id, and the duplicate call creates no row. Commit.

### Step 4.2 — SSE relay

**Goal:** `GET /api/generations/:id/events` streams progress to the browser and closes cleanly on disconnect. This is the spike's `job-stream.server.ts` moved onto `generations`.

**Do:** move the route; keep `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, the per-request `AbortSignal` closing the SDK subscription, and the terminal snapshot for `done`/`failed` rows (no Comfy call). Keep `/api/spike/status` as `/api/debug/streams` behind `ENABLE_DEBUG=1`.

**Verify**

```sh
ID=<generation id from 4.1>
curl -sD - -o /dev/null --max-time 3 localhost:3030/api/generations/$ID/events | grep -iE 'cache-control|x-accel|content-type'
# no-cache, no-transform · no · text/event-stream
curl -s localhost:3030/api/debug/streams     # active 0 after the curl above timed out
curl -sI localhost:3030/api/generations/not-a-uuid/events | head -1      # 400
npm run test:server                           # the four abort/terminal cases still pass on the new table
```

Open the still-running job from 4.1 in a browser tab, watch the percent rise, close the tab, and confirm `active` drops back to 0 within a second.

**Done when:** headers exact, subscriptions return to 0, tests green. Commit.

### Step 4.3 — `finalize`: download, poster, hash, done

**Goal:** when Comfy says `complete`, the output is re-hosted on disk and the row becomes `done`; the same code runs from a status read if the SSE path missed it.

**Do:** `src/server/finalize.ts`:

- `finalize(id)` under an in-process lock keyed by id: `jobs.get(providerJobId)` → if not complete, return; download the signed URL to a temp file; `ffmpeg -frames:v 1` poster at 0.5 s; SHA-256; insert `assets` rows (`role: provider_output` and `poster`); `transition(running|finalizing → done)`; set `finished_at`.
- Call it from the SSE handler on the `complete` event **and** from `GET /api/generations/:id` when status is `queued|running`.
- No audio mux: the audit confirmed the template passes the driving clip's audio through.

**Verify**

Using the job from 4.1 (now complete on Comfy):

```sh
curl -s localhost:3030/api/generations/$ID | jq '{status, final_asset_id, poster_asset_id}'   # done, both ids set
F=$(sqlite3 data/app.sqlite "select path from assets where id=(select final_asset_id from generations where id='$ID')")
shasum -a 256 "$F"; sqlite3 data/app.sqlite "select sha256 from assets where path='$F'"      # equal
ffprobe -v error -select_streams a -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "$F"    # aac,44100,2 — same as the driving clip
docker restart <container> && curl -s localhost:3030/api/generations/$ID | jq .status        # still done
```

Negative control: temporarily make `jobs.get` return `running` in a test double and assert `finalize` returns without touching the row (this is "elapsed time never completes a job", kept from the spike).

**Done when:** the row is `done` with hashed assets, survives a restart, and the time-based negative control passes. Commit.

### Step 4.4 — Failure states and retry with a new seed

**Goal:** a provider error becomes a readable `failed` row; "retry" is a child generation.

**Do:** map SDK error classes to `error_code` (`provider_rejected`, `timeout`, `unknown`); `retry(id)` creates a child row with the same recipe except a fresh seed and `parent_id = id`. The `unknown` state (crash window) is **never** retried automatically; the API returns `409` with a message pointing at the README.

**Verify**

```sh
npm run test:server    # new cases: error mapping; retry creates a child with new seed; retry on an unknown row → 409
```

Force a failure cheaply: submit a graph with a deliberately invalid node (`class_type: "Nope"`) through the dead-port path or a mock and confirm `failed` + `provider_rejected` without a job.

**Done when:** tests green. Commit. The server side of the pipeline is complete here.

---

## Phase 5 — The UI

### Step 5.1 — Motion picker and upload states

**Goal:** the first screen. Grid of looping muted sample previews plus an upload drop zone with the states from the plan: `uploading % → probing → too long (trim UI) | rejected (reason) → ready`.

**Do:** route `/` with `validateSearch` for `{ motion?: string }`; `MotionGrid`, `UploadZone` (uses `XMLHttpRequest` or `fetch` with progress), `TrimDialog` (range slider over a `<video>`, max 8 s, calls the trim endpoint). Hint text: "one person, full body, steady framing".

**Verify**

- Playwright: upload `tests/fixtures/long-12s.mp4` → the trim dialog appears; confirm → state `ready`. Upload `short-2s.mp4` → "too short" shown, no asset created. Upload `audio-only.m4a` → "no video".
- `npm run test:e2e` green; `npm run typecheck`.
- Manually on a phone (same Wi-Fi, `npm run dev --host`): the grid previews loop, the drop zone accepts a camera-roll clip.

**Done when:** the three fixture cases pass in Playwright and the phone check is done. Commit.

### Step 5.2 — Character picker

**Goal:** second screen: sample characters, or upload with the consent checkbox.

**Do:** route search param `{ character?: string }`; `CharacterGrid`; `CharacterUpload` with the checkbox gating the submit button and the 422 surfaced as an inline message.

**Verify**

- Playwright: pick a sample → URL contains `?motion=…&character=…` and a reload keeps both (typed search params doing their job). Upload without consent → button disabled; with consent → row created.
- Invalid `character=xyz` in the URL falls back to none, no crash (A2 behaviour, still true).

**Done when:** Playwright green. Commit.

### Step 5.3 — Generate screen and progress

**Goal:** the button, the options, and a progress UI that never implies time remaining.

**Do:** `GenerateForm` with reshoot-angle presets from `workflows/angles.json` (3 presets to start; the phrasing comes from the Oct 19 benchmark — if it is not done, ship `front`, `three-quarter`, `profile` as placeholders and mark them), an appearance/background prompt, seed under "Advanced". On submit: call the server function, navigate to `/g/:id`, open the SSE stream, render **percent only** plus the status word. Pre-rendered sample × sample combinations (Step 9.2) open instantly; until then they generate.

**Verify**

- Playwright with Comfy at a dead port: clicking Generate shows `failed` with the reason; **no** `POST` to the generate function happens when the form is invalid (reuse the 1.2 guard pattern).
- Manual 💸-free check: open `/g/<id of the 4.1 job>` → shows `done` immediately from the terminal snapshot without a Comfy call (watch `active` stay 0).

**Done when:** both checks pass. Commit.

### Step 5.4 — Compare view on one clock

**Goal:** source and result side by side, one scrubber, one play/pause, result audio only; swipe slider on mobile.

**Do:** `ComparePlayer` with two `<video>` elements; the result is the master (`timeupdate` drives the source's `currentTime`, `play`/`pause` mirrored, source muted). Shared scrubber. On narrow screens, a swipe slider (`clip-path` over the result) instead of two panels. Poster from the poster asset.

**Verify**

- Playwright: after `play()`, within 500 ms both videos report `paused === false`; after seeking the master to 2 s, the source's `currentTime` is within 0.1 s. Both must be served with Range support — check the network panel shows `206` responses when seeking.
- Manual on a phone: the swipe slider follows the finger; audio plays once (not doubled).

**Done when:** sync assertion passes and phone check is done. Commit.

### Step 5.5 — Download and remix

**Goal:** the final MP4 download, "same motion, another character", "same character, another motion".

**Do:** download link → `/media/<final asset>.mp4` with `Content-Disposition: attachment`; remix buttons navigate to `/` with the kept id in the search params.

**Verify**

```sh
curl -sI localhost:3030/media/<asset>.mp4?download=1 | grep -i content-disposition    # attachment; filename=…
```

Playwright: remix keeps exactly one of `motion`/`character` in the URL.

**Done when:** both pass. Commit. The full flow now works on desktop and phone (the plan's Oct 22 exit criterion).

---

## Phase 6 — Share and reproduce

### Step 6.1 — Media route hardening

**Goal:** `/media/*` serves finals and posters with single-range, suffix-range, `206`/`416`, HEAD, and long cache headers for content-addressed paths.

**Do:** move the spike's range code onto the assets table (path by id, never by user input); add `Cache-Control: public, max-age=31536000, immutable` (the path contains the hash); add `ETag` = sha256.

**Verify**

```sh
A=<final asset id>
curl -sI -H 'Range: bytes=0-99' localhost:3030/media/$A.mp4 | grep -E 'HTTP|Content-Range'     # 206, bytes 0-99/<size>
curl -sI -H 'Range: bytes=-10' localhost:3030/media/$A.mp4 | grep -E 'HTTP|Content-Length'    # 206, 10
curl -sI -H 'Range: bytes=99999999-' localhost:3030/media/$A.mp4 | grep -E 'HTTP|Content-Range' # 416, bytes */<size>
curl -sI localhost:3030/media/../../etc/passwd | head -1                                       # 404
npm run test:server
```

**Done when:** all four codes are right and the traversal attempt is a 404. Commit.

### Step 6.2 — Share page with SSR Open Graph

**Goal:** `/r/:slug` renders server-side with `og:video`, `og:image` (poster), title; "use this motion with my character" starts a new generation with the motion pre-selected.

**Do:** `share_slug` generated on `done` (short, unguessable); the route loads the row on the server; `<meta>` tags from the loader; a muted looping result, the source thumbnail, the recipe summary (Step 6.3), model names and licenses, an "open weights only" badge linking `models.lock` and the CI check.

**Verify**

```sh
curl -s localhost:3030/r/<slug> | grep -oE '<meta property="og:[a-z:]+"[^>]*>'    # og:video, og:image, og:title present; og:video content is an absolute https URL to /media/…
curl -s -o /dev/null -w '%{http_code}\n' localhost:3030/r/does-not-exist           # 404
```

After deploying (Step 7.3), paste the link into X's card validator or a DM to yourself: the card shows the video.

**Done when:** raw HTML (no JS) carries the tags and the 404 is clean. Commit.

### Step 6.3 — Recipe panel and "re-run recipe"

**Goal:** every result shows what made it; re-run creates a child with the identical recipe.

**Do:** `RecipePanel` (collapsed by default) rendering the stored `recipe` JSON: workflow id/version/sha, models with licenses, all params, input hashes, target. "Re-run recipe" → `rerun(id)` → child row with `parent_id`, same seed. Also expose `GET /api/generations/:id/recipe.json`.

**Verify**

- `curl -s localhost:3030/api/generations/$ID/recipe.json | jq .workflow.sha256` equals the README hash from 1.3.
- `npm run test:server`: `rerun` creates a child with the same `recipe_hash` and the same seed; it returns the **parent's** output if the parent is `done` and the target is unchanged (dedupe), so re-run is free unless something in the recipe changed.

**Done when:** tests green, panel renders. Commit.

---

## Phase 7 — Protect it and put it online

### Step 7.1 — Access codes

**Goal:** uploads and generation require a code; pre-rendered samples stay free.

**Do:** migration `003` adds `access_codes` (§7). `POST /api/session` exchanges a code for an httpOnly cookie; the generate function and both upload routes check it; sample × sample lookups that hit a pre-render do not. `scripts/mint-code.mjs <label> <max>` prints a code and stores its hash.

**Verify**

```sh
curl -s -o /dev/null -w '%{http_code}\n' -F file=@fixtures/wan/driving.mp4 localhost:3030/api/uploads     # 401
CODE=$(node scripts/mint-code.mjs judges 50)
curl -s -c /tmp/jar -d "{\"code\":\"$CODE\"}" -H 'content-type: application/json' localhost:3030/api/session   # 204
curl -s -b /tmp/jar -o /dev/null -w '%{http_code}\n' -F file=@fixtures/wan/driving.mp4 localhost:3030/api/uploads   # 201/200
sqlite3 data/app.sqlite "select label,used,max_generations from access_codes"
```

**Done when:** 401 without, success with, `used` increments on generate. Commit.

### Step 7.2 — Rate limit and in-flight cap

**Goal:** a public link cannot drain the credits.

**Do:** in-memory token bucket per code and per client hash (uploads: 10/min; generate: 3/min); global in-flight counter = plan concurrency (1 on Standard); when full, generate returns `503` with `{ reason: "queue_full", retry_after }` and the UI shows "queue full".

**Verify**

```sh
for i in $(seq 1 5); do curl -s -b /tmp/jar -o /dev/null -w '%{http_code} ' localhost:3030/api/generate -d '{}' -H 'content-type: application/json'; done; echo   # 4xx… then 429
# set IN_FLIGHT_MAX=0 and call generate once → 503 queue_full, no row created
```

**Done when:** 429 and 503 paths both verified and neither creates a generation row. Commit.

### Step 7.3 — Deploy, and prove SSE survives the host's proxy

**Goal:** the live link. Railway or Fly, one container, volume for `/app/data`, `COMFY_API_KEY` as a secret.

**Do:** deploy the same image `compose.yaml` builds. Set `PUBLIC_BASE_URL` for absolute OG URLs. Mint a judges code.

**Verify**

```sh
H=https://<your-host>
curl -sI $H/ | head -1                                                           # 200
curl -sI -H 'Range: bytes=0-99' $H/media/<asset>.mp4 | grep -E 'HTTP|Content-Range'   # 206 through the proxy
# the important one: an SSE stream held open for 5 minutes with heartbeats every 15 s
curl -sN --max-time 310 $H/api/generations/<running or synthetic id>/events | tee /tmp/sse.log | wc -l   # >= 20 heartbeat lines, no early close
curl -s $H/r/<slug> | grep -c 'property="og:'                                   # 7
```

If the stream is cut early, the host buffers or times out long responses: add a `: ping` comment every 15 s (if not already), and check the host's docs for a request timeout setting. Record which host and which setting in `README.md`.

**Done when:** a 5-minute stream stays open and a share link unfurls with video on X. Commit the deploy config.

### Step 7.4 — Someone else completes the flow on their phone

**Goal:** the plan's Oct 23 exit criterion.

**Do:** send the link and a code to one person. Watch nothing; ask for a screenshot of the compare view.

**Verify:** they reach the compare view without you explaining anything. Note every question they asked in `CHECKLIST.md`; each one is a UI fix for Step 9.

**Done when:** the screenshot exists.

---

## Phase 8 — The open-weights proof

### Step 8.1 — `models.lock`

**Goal:** every model file the workflow loads, pinned with source, hash and license.

**Do:** `models.lock` (JSON): for each loader node in `motion-transfer.v1.json` (`UNETLoader`, `VAELoader`, `CLIPLoader`, `CLIPVisionLoader`, `LoraLoaderModelOnly`), the filename, the Hugging Face URL in the Comfy-Org repack, the SHA-256, and the license (Apache-2.0 for Wan Animate 2). `scripts/check-models-lock.mjs` asserts every filename referenced in the workflow has an entry.

**Verify**

```sh
node scripts/check-models-lock.mjs      # "5 model files, 5 locked, 0 missing"
# negative: remove one entry → exit 1
```

**Done when:** the check passes and the negative control fails. Commit.

### Step 8.2 — `check-open-weights` in CI with a planted fixture

**Goal:** CI fails if any workflow in the repo uses a partner or API node; a badge in the README says so.

**Do:** `scripts/check-open-weights.mjs` scans `workflows/*.json` for `class_type` matching the forbidden list (`Higgsfield*`, `*Api*`, `Kling*`, `Veo*`, `Gemini*`, `Runway*`, `Luma*`, `MiniMax*`, `LTX*` API nodes — keep the list in `scripts/forbidden-nodes.json`) and for `api_node: true` in the node definitions when available. `tests/fixtures/partner-node.json` contains one `HiggsfieldGenjutsuMotionTransfer` node; a test runs the checker against it and asserts exit 1. CI runs the checker on `workflows/`; README gets the workflow badge.

**Verify**

```sh
node scripts/check-open-weights.mjs workflows/                       # exit 0, "0 forbidden"
node scripts/check-open-weights.mjs tests/fixtures/partner-node.json  # exit 1, names the node
gh run list --limit 1                                                # success; badge green on the README
```

**Done when:** both exit codes are right and the badge renders. Commit.

### Step 8.3 — Self-host on a Runpod 5090

**Goal:** the same app, `COMFY_BASE_URL` pointed at your own ComfyUI through `comfy-api-proxy`, completes a render. Measured VRAM and seconds per clip go into the README.

**Do:**

1. Rent a 5090 pod with a ComfyUI template; install the Wan Animate 2 files from `models.lock` (int8 distilled first); install `comfy-api-proxy`; expose it.
2. Add a `selfhost` profile to `compose.yaml` documenting the two env vars (`COMFY_BASE_URL`, and the proxy's auth if any).
3. Run one render through the **app**, not through the ComfyUI UI. While it runs: `nvidia-smi --query-gpu=memory.used --format=csv -l 1 | tee work/vram.csv`.
4. If int8 distilled fits, try base int8; if not, write the limit down.

**Verify**

- The generation row shows `target: selfhost` in its recipe and reaches `done`.
- `max(work/vram.csv)` and the wall time per clip are in the README table, with the variant and resolution.
- The output plays and has the passthrough audio.
- Nothing in the app changed except `COMFY_BASE_URL` (`git diff --stat` shows only compose and README).

**Done when:** one self-hosted render through the app and a filled README row. This is the Open Weights Only proof — never cut it.

---

## Phase 9 — Samples, polish, submission

### Step 9.1 — Motion library and sample characters, with licenses

**Goal:** 6–10 self-filmed or CC0 motion clips and 3–4 generated characters, every one with a license file.

**Do:** `samples/motions/<slug>/` with the clip, `LICENSE.txt` (self-filmed or CC0 source URL) and `manifest.json` (title, duration, attribution); `samples/characters/` from a Klein-only workflow if it runs on your target, else from any open-weights image model you can name. The seed script inserts both with `is_sample = 1`. Remember the output carries the clip's audio: no music in self-filmed clips.

**Verify**

```sh
for d in samples/motions/*/; do test -f "$d/LICENSE.txt" || echo "missing license: $d"; done
node scripts/seed-samples.mjs && sqlite3 data/app.sqlite 'select count(*) from motions where is_sample=1; select count(*) from characters where is_sample=1'
ffprobe -v error -show_entries format=duration -of csv=p=0 samples/motions/*/clip.mp4    # each between 3 and 8
```

**Done when:** no missing license, counts match the folders, durations in range. Commit.

### Step 9.2 — 💸 Pre-rendered sample matrix

**Goal:** every sample motion × sample character opens instantly and costs nothing at demo time.

**Do:** `scripts/prerender.mjs` iterates the matrix **serially** (Standard allows one concurrent job), calling the same `generate` path with `is_prerendered = 1`, skipping any `recipe_hash` already `done`. Run it overnight; re-running resumes.

**Verify**

```sh
sqlite3 data/app.sqlite 'select count(*) from generations where is_prerendered=1 and status="done"'    # = motions × characters
# kill the script mid-run and restart it: the count continues from where it stopped, no duplicate jobs in the Comfy queue
```

Record total credits spent in `CHECKLIST.md`.

**Done when:** the matrix is complete and a sample × sample click on the live site opens the compare view with no network call to Comfy.

### Step 9.3 — Fresh-clone judge test

**Goal:** the rules' hard requirement — a stranger can run it.

**Do:** on a machine (or a fresh VM/user account) that has never seen the repo: `git clone <url> && cd <repo> && cp .env.example .env` → paste a key → `docker compose up` → open `localhost:3030` → generate with a sample motion and sample character (pre-rendered, so free) → reach the compare view. Time it. Fix anything that needed a workaround, then do it again.

**Verify:** the second run needs zero workarounds. Save the terminal log as `docs/fresh-clone-<date>.log` and link it from the README.

**Done when:** the log exists and the README links it. This step is never cut.

### Step 9.4 — Demo video and submission

**Goal:** the ≤ 2:00 video, the social post, the form.

**Do:** follow §10 of the MVP plan for the shot list (result in the first 5 s; live flow; share page; recipe re-run; CI badge + the self-host render; every model and tool named; `docker compose up` + repo URL + `#OpenSourceHiggsfield`). Then the §11 checklist, line by line.

**Verify**

- Video length ≤ 2:00 (`ffprobe -show_entries format=duration`).
- Every link in the README and the post opens in an incognito window.
- The challenge page re-read in a browser on submission day; nothing in §2 of the plan changed.
- Submission confirmation screenshot saved; `v1.0.0` tagged; `main` frozen until Nov 6.

**Done when:** the confirmation screenshot is in `CHECKLIST.md`. Submit **by 12:00 Warsaw on Oct 30** (deadline 17:00).

---

## What to cut, and in which order

If time runs out, cut from the bottom of this list upward — never the top:

1. Klein-generated sample characters (use any open-weights image model, or hand-made images)
2. The re-run button (keep the recipe display)
3. Angle presets beyond three
4. Vertical demo cut
5. Base-variant VRAM row (keep distilled)

Never cut: Step 8.3 (self-host proof), Step 9.3 (fresh-clone test), Step 8.2 (open-weights check).

## Open items that feed values into these steps

| Item | Feeds | Source |
|---|---|---|
| Credits per render (C3) | 1.6, 9.2 budget | measure in 1.6 |
| Default variant, max clip length, resolution presets | 1.4 values, 3.2 limits, 5.3 presets | Oct 19 benchmark |
| Angle phrasings that work | 5.3 `angles.json` | Oct 19 benchmark |
| Does Cloud execution count as open weights? | 8.3 is the answer either way | Comfy Discord `#developer-platform` |
| Can a custom node pack run on Comfy Cloud? | the Most Innovative feature (separate page, later) | ask with the above |
