# Building an AppKeep app

This is an app for the AppKeep marketplace: a single Cloudflare Worker that
buyers pay for once and run on their AppKeep hosting plan. Every buyer gets
their own copy with a private database. Read this before changing anything.

## The rules

- **The platform signs people in. Never build login, sessions or passwords.**
  On a signed-in request you get `x-altstack-owner-id`, `x-altstack-owner-email`
  and `x-altstack-role` (`owner`, `admin` or `member`), plus `x-altstack-owner-name`
  (URI-encoded) and, for people who sign in with Google, `x-altstack-owner-avatar` (their photo). No header means a
  public visitor. The platform strips these headers from client requests, so
  you can trust them. Send people to `/_altstack/login?next=/your/path` to sign in.
- **Everyone signed in belongs to the buyer's account.** On a team, members
  share the app. If something should be owner/admin only, check `x-altstack-role`.
- **Only what `altstack.json` declares is allowed.** Outbound `fetch()` to a
  host not in `egress` (or the API hosts of a declared connection) is blocked.
  Platform services not in `services` throw. Buyers see every permission and
  its `why` on the listing before they pay, so explain each one.
- **No Node servers.** No Express, Next.js, Prisma, Postgres, Redis, BullMQ,
  nodemailer or native modules. Use Hono (or a plain `fetch` handler), `env.DB`
  and `env.KV`. Do slow work with `ctx.waitUntil`.
- **Never hard-code secrets.** The review rejects keys it recognises. Per-buyer
  values go in `settings`; third-party accounts go in `connections`.

## What you get

| Binding | What it is |
|---|---|
| `env.DB` | D1-compatible SQLite, private to each buyer: `prepare().bind().all()/first()/run()/raw()`, `batch()`, `exec()` |
| `env.KV` | `get(key, "json"?)`, `put(key, value, { expirationTtl }?)`, `delete(key)`, `list({ prefix })` |
| `env.<KEY>` | Each entry of `settings` in `altstack.json`, as the buyer filled it in |
| `env.ALTSTACK.appUrl` | This copy's public address (its custom domain if it has one) |
| `env.ALTSTACK.log(level, message)` | Writes to the activity log in the buyer's dashboard |
| `env.ALTSTACK.connections(provider?)` | Accounts the buyer connected: `[{ id, provider, external_id, name, status, scopes }]` |
| `env.ALTSTACK.connectUrl(provider, next?)` | Link that starts connecting an account (owners and admins) |
| `env.ALTSTACK.disconnect(id)` | Removes one of the app's connected accounts (check the person may first) |
| `env.ALTSTACK.members()` | People on the buyer's account (needs service `members`) |
| `env.ALTSTACK.sendEmail({ to, subject, text, replyTo? })` | Sends from "Your App via AppKeep" (needs service `email`; 200 a day) |
| `env.ALTSTACK.emit(name, data)` | Sends `custom.<slug>.<name>` to the buyer's webhooks (Slack, Zapier, ...) |
| `env.ALTSTACK.ai` | Images, video, voice, music, video assembly, captions and a text model, paid from the buyer's balance (needs service `ai`; see below) |
| `env.ALTSTACK.wallet` | The buyer's prepaid balance: `balance()`, and `hold`/`capture`/`release`/`charge` (needs service `wallet`) |
| `env.ALTSTACK.topUpUrl(next?)` | Link that sends people to add money, then back to `next` |
| `env.MEDIA` | File storage with the R2 API: `get(key, { range })`, `head`, `put(key, value, { httpMetadata })`, `delete(key or keys)`, `list({ prefix, cursor })`, `createMultipartUpload` / `resumeMultipartUpload` (needs service `storage`; counts toward the buyer's stored data) |
| `env.ASSETS` | `fetch(request)` for your own static files (prebuilt apps; see below) |
| `env.<NAME>` from `ratelimits` | `limit({ key })` → `{ success }`, like Cloudflare's rate limiting binding |
| `env.CF_VERSION_METADATA` | `{ id, tag }`: the version that's running (`tag` is your `version`) |

Code that reads bindings with `import { env } from "cloudflare:workers"` (SvelteKit's adapter does) sees the same ones.

## Add a table

1. Add a new file in `migrations/`, like `0002_add_tags.sql`. Files run once
   each, in name order, inside a transaction. Never edit a migration that has
   shipped: buyers' databases already ran it. No `BEGIN`/`COMMIT`, `ATTACH` or `VACUUM`.
2. Query it through `env.DB`.

## Connect a third-party account (Instagram, Facebook, TikTok, YouTube, LinkedIn, X, Threads, Google, Microsoft, Slack, GitHub)

The platform holds the OAuth client, so buyers just click Connect. You never
see the token. Providers: `instagram`, `facebook`, `tiktok`, `youtube`, `linkedin`,
`x`, `threads`, `google`, `microsoft`, `slack`, `github`. A `facebook` connection is one Facebook Page
(connecting adds each Page the person shares that they can post to), and a `youtube`
connection is one channel. Connecting again adds another account; the login asks which
one where the provider allows it. `env.ALTSTACK.disconnect(id)` removes one.

X bills per post, so each post (`POST /2/tweets`) is paid from the buyer's balance: about
$0.02, or $0.25 with a link. With too little balance the call returns 402 with
`code: "insufficient_funds"`; send people to `env.ALTSTACK.topUpUrl(next)`.

1. Declare it: `"connections": [{ "provider": "google", "why": "Read your calendar to find free slots", "scopes": ["https://www.googleapis.com/auth/calendar.readonly"] }]`.
   Each provider has base scopes; `scopes` adds optional ones (the review lists what's offered).
2. Link owners to `env.ALTSTACK.connectUrl("google", "/settings")`. They come
   back to `next` with `?connected=google`.
3. Call the API with the connection's id in a header; the platform adds the token:
   ```ts
   const [google] = await env.ALTSTACK.connections("google");
   const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
     headers: { "x-altstack-connection": google.id },
   });
   ```
   A 401 with `code: "connection_unavailable"` means the buyer must reconnect.
4. Instagram pushes events (comments, messages) to the platform, which forwards
   them to `POST /_altstack/webhooks/instagram` with `x-altstack-connection-id`.
   Only the platform can reach `/_altstack/` paths, so you don't verify signatures there.

## Add an AI tool

Buyers connect Claude, Cursor or another MCP client to their account once, and
it can use the tools of every app they run.

1. Declare it in `altstack.json`:
   ```json
   "tools": [{ "name": "add_note", "description": "Add a note. Returns its id.", "risk": "write",
     "input": { "type": "object", "properties": { "body": { "type": "string" } }, "required": ["body"] } }]
   ```
   `name`: up to 30 lowercase letters, numbers or underscores. `risk` is
   `read`, `write` or `destructive`; be honest, because destructive tools stay
   hidden from AI clients. `input` is a JSON Schema object.
2. Serve it at `POST /_altstack/tools/<name>`. The body is the arguments as JSON
   and the identity headers say who's calling. Return JSON (shown to the
   assistant) with a 2xx, or a 4xx with a message it can act on.
3. Keep it small and specific: one job per tool, short descriptions that say
   what it returns. The review boots your app and calls each tool with `{}`. A
   404 or 5xx fails the review; a 400 for missing arguments is fine.

## Generate images and video (service `ai`)

The platform runs the models (Seedance, Kling, Veo, Wan, Nano Banana, GPT Image and
more, through Sume) with its own key and queue. Buyers pay from their prepaid
balance: each request is priced up front, held, and charged only if it completes.
Declare `"services": [{ "name": "ai", "why": "..." }]`; no egress needed.

```ts
const models = await env.ALTSTACK.ai.models("video");   // [{ id, name, kind, capabilities, from_micros, unit }]
const { price_micros } = await env.ALTSTACK.ai.estimate("seedance-2-mini", { prompt, duration: 5, resolution: "720p" });
const r = await env.ALTSTACK.ai.submit("seedance-2-mini", { prompt, duration: 5, resolution: "720p" }, { user: ownerId, ref: requestId });
if (!r.ok) return Response.redirect(env.ALTSTACK.topUpUrl("/"));  // r.reason === "insufficient_funds"
const job = await env.ALTSTACK.ai.job(r.job.id);  // status: queued | submitted | processing | completed | failed | canceled
// job.outputs: [{ url, type, content_type }], served from this app's own address
```

- Amounts are micro-dollars: 1,000,000 = $1. Show `price_micros` before people click.
- `input` is the model's request body (`prompt`, `aspect_ratio`, `resolution`, `duration`,
  `generate_audio`, `num_images`, `image_url`, `image_urls`, ...). `capabilities` says what each model takes.
- Pass a `ref` (one per user action) so a retried request doesn't pay twice.
- `ai.cancel(id)` works until generation starts. Failed and canceled jobs cost nothing.
- `ai.upload(file)` stores an input image and returns a public `url` to pass as `image_url`.
- Outputs and uploads count toward the deployment's storage. `ai.storage()` returns the bytes
  and file counts; `ai.delete(id or [ids])` deletes finished jobs' files (up to 100 a call);
  `ai.deleteUploads({ olderThanMs })` deletes uploaded images. Let users clean up.
- Jobs are queued fairly across every app on the platform, so poll `ai.job()` (every few
  seconds) rather than waiting in one request.

### Voice, music, assembling and captioning

`submit` also runs these; `ai.models(kind)` lists them, and `ai.models()` with no kind lists only image and video.

```ts
await env.ALTSTACK.ai.voices("sonic");                       // { voices: [{ id, name, language, preview_url, ... }] }
await env.ALTSTACK.ai.submit("sonic-3.6", { transcript, voice: { mode: "id", id }, output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 } });
await env.ALTSTACK.ai.submit("sume/music-auto", { prompt, duration_seconds: 30 });
await env.ALTSTACK.ai.submit("timeline-1.0", { audio: { url: voiceUrl, duration_seconds }, video: [{ source_url: clipUrl, start: 0, duration: 4, fit: "cover" }], output: { width: 720, height: 1280, fps: 30, format: "mp4" } });
await env.ALTSTACK.ai.submit("captions-1.0", { video_url: renderUrl, style: "highlight", script_text });
```

- `timeline-1.0` and `captions-1.0` only take files this app generated: pass the `url` from `ai.job().outputs`. Anything else is refused.
- `outputs[n].duration` is the length in seconds of voice and music. `video[0].start` must be 0.
- Captions are priced for videos up to 60 seconds.

### Read social posts and your own files

- `ai.social(endpoint, params, ref)` runs one read from the fixed list in `platform/src/ai/social.ts` (TikTok, YouTube and Instagram search, trending, profiles, transcripts, ad libraries). Each read costs a flat $0.002 from the buyer's balance. It returns `{ ok: true, data, charged_micros }`, or `{ ok: false, reason: "insufficient_funds" | "pending" }`. The shape of `data` isn't documented, so read it defensively and cache results in `env.KV`.
- `ai.read(url, range?)` returns the bytes of one of this deployment's generated files or uploads.

### Write text (`ai.text`)

One turn with Claude, charged by the tokens it uses. To use tools, run the loop yourself: call again with the `tool_result`.

```ts
const r = await env.ALTSTACK.ai.text({ system, messages: [{ role: "user", content: "..." }], effort: "medium", max_tokens: 4000, json_schema }, { user: ownerId, ref: requestId });
if (!r.ok) return Response.redirect(env.ALTSTACK.topUpUrl("/"));
if (r.stop_reason === "refusal") { /* say so; r.text is empty */ }
```

- `model` is `claude-opus-5-5` (the default) or `claude-sonnet-5-5`. `json_schema` makes `r.text` JSON of that shape.
- `tools` are your own (`name`, `description`, `input_schema`); server-side tools aren't offered.
- `max_tokens` is capped at 16,000. A `ref` can only be used once.

## Charge for your own costs (service `wallet`)

For usage you pay for yourself (an API you call with your own key, say), charge
the buyer's balance. You earn your sale share of what you charge, and buyers see
every charge with its description and your app's name.

```ts
const r = await env.ALTSTACK.wallet.charge({ amount_micros: 20_000, description: "1 transcription minute", ref: jobId });
if (!r.ok) return Response.redirect(env.ALTSTACK.topUpUrl("/jobs"));
// Price known only at the end? Hold first, then capture up to the held amount (or release it).
const h = await env.ALTSTACK.wallet.hold({ amount_micros: 500_000, description: "Render", ref });
await env.ALTSTACK.wallet.capture(h.hold_id, 320_000);
```

## Store files (service `storage`)

Declare `"services": [{ "name": "storage", "why": "Keeps the photos you upload" }]` and use `env.MEDIA`
like an R2 bucket. Keys are relative to your app's own folder (no leading `/`, no `..`), files are
deleted with the deployment, and they count toward the buyer's plan. Stream large files with
`createMultipartUpload`: a stream whose length isn't known (a request body) is read into memory
first, up to 100 MB.

## Run on a schedule

`"cron": ["* * * * *"]` (every minute) or `"*/5 * * * *"` (every 5 minutes) calls your Worker's
`scheduled(event, env, ctx)` export, with `event.cron` and `event.scheduledTime`. Each run counts as a
request. Paused apps don't run, and a failing run is written to the owner's activity log at most
once an hour.

## Rate limits

`"ratelimits": [{ "name": "LOGIN_LIMIT", "limit": 10, "period": 60 }]` gives you `env.LOGIN_LIMIT.limit({ key })`,
counted per key in your app's KV over a fixed window of `period` seconds (10 or 60). The defaults are 20 per 60 seconds.

## Add a setting

`"settings": [{ "key": "BUSINESS_NAME", "label": "Business name", "required": true, "help": "Shown in emails" }]`.
`secret: true` hides it and encrypts it at rest. Read it as `env.BUSINESS_NAME`.
Keys are UPPER_SNAKE_CASE. Prefer `connections` over asking buyers to paste API keys.
For an encryption key or signing secret, add `"generate": "secret"`: the platform fills in 256 random
bits (as 64 hex characters) for each deployment, and buyers never see or change it.

## Run it locally

```bash
npx appkeep dev              # http://localhost:3000, already signed in as the owner
```

No account, login or platform needed. It builds the app the way `publish` does, runs it in the real Workers
runtime and reloads the page when you save. Use the badge in the page to switch between owner, admin, member
and a signed-out visitor; `/_altstack/login` and `/_altstack/logout` work too.

- **Data** stays in `.appkeep/dev` between runs (git ignores it). `--reset` wipes it. Migrations run as in production.
- **Settings** come from a `.dev.vars` file (`KEY=value`), then each setting's `default`.
- **The rules apply:** a `fetch()` to a host not in `egress` gets the same 403, and a service not in `services` throws.
- **Local stand-ins, free:** `env.ALTSTACK.ai` finishes jobs in 3 seconds with placeholder files and canned text, the
  balance starts at a fake $25, email and `emit` print to the terminal, and connections are fake accounts whose API
  calls get a 401 `connection_unavailable`. Real output, real email and real connections need a published app.
- **Cron** runs on its schedule, or from the badge. AI tools can be tried with curl:
  `curl -X POST localhost:3000/_altstack/tools/list_notes -d '{}'`.
- CPU limits aren't enforced locally. Run `npx appkeep check` before publishing: it applies review rules `dev` doesn't.

With a Vite frontend (React, Vue and so on) and a Worker API, this keeps hot reload. Pages and assets come from Vite,
API calls and sign-in go to the Worker, and `env.ASSETS` reads from Vite:

```bash
npx appkeep dev --frontend http://localhost:5173 --run "npx vite --port 5173 --strictPort"
```

An app built by its own toolchain runs from its build output, and reloads when that changes (SvelteKit's `vite dev`
doesn't run your Worker, so build it first, as below):

```bash
npx appkeep dev --prebuilt dist/_worker.js --assets .svelte-kit/cloudflare
```

## Check, then publish

```bash
npx appkeep login            # once; approve it in the browser
npx appkeep check ./my-app   # runs the automated review without submitting
npx appkeep publish ./my-app # submits for review; bump "version" every time
```

An app built by its own toolchain (SvelteKit, Vite, wrangler) can be published as it is:
one ES module plus a folder of static files, which are served at their paths before your
Worker runs (cached for good under `/_app/immutable/`). For SvelteKit with the Cloudflare adapter:

```bash
npx vite build && npx wrangler deploy --dry-run --outdir dist
npx appkeep publish . --prebuilt dist/_worker.js --assets .svelte-kit/cloudflare
```

`altstack.json` and `migrations/` still come from the app's directory. The module can be up to
10 MB and the static files up to 100 MB in all (25 MB each); unchanged files aren't uploaded again.

Before publishing, go through `SECURITY-REVIEW.md` for every change that touches
identity, public routes, tools, connections, settings or queries.

Approved versions roll out to every buyer on automatic updates and run only the
new migrations, so a version must work with data written by every earlier one.

## Let buyers change the code

`"include_source": true` lets buyers download the source. Add `"allow_changes": true`
too (open-source licenses like MIT allow it) and buyers on Plus and up can run
their own changed version on their deployment:

```bash
npx appkeep push mybot -m "Adds a CSV export button"   # from the changed source folder
```

A pushed version keeps the maker's `version` it started from, can't add `services`
or `connections`, keeps the maker's migrations unchanged and names its own
`custom_*.sql`. It goes through the automated checks but no human review, and it
never auto-updates.
