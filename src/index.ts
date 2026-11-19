// Inkpact: send PDFs for signature. Read AGENTS.md for the platform rules.
// Signed-in people (owner, admin, member) prepare and send envelopes under /api.
// Signers are outside people with no account: they reach /s/<token> through a link.
import { Hono, type Context } from "hono";
import { html, raw } from "hono/html";
import { buildSignedPdf } from "./stamp";

declare const __APP_VERSION__: string;
const V = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  ORG_NAME?: string;
  SIGN_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  ALTSTACK: {
    appUrl: string;
    log(level: string, msg: string): Promise<void>;
    sendEmail(m: { to: string; subject: string; text: string; replyTo?: string }): Promise<unknown>;
  };
};
type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const MAX_PDF = 15 * 1024 * 1024;
const MAX_IMAGE = 400_000;
const COLORS = ["#0e7c66", "#6d4bd8", "#d9480f", "#1c7ed6", "#c2255c", "#5c940d", "#e67700", "#0b7285"];
const FIELD_TYPES = new Set(["signature", "initials", "date", "name", "text", "checkbox"]);

// ---------- helpers ----------
const now = () => Date.now();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(24)));
const newId = () => crypto.randomUUID();
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const emailOk = (e: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) && e.length <= 254;
const appUrl = (c: C) => (c.env.ALTSTACK?.appUrl || new URL(c.req.url).origin).replace(/\/$/, "");
const signLink = (c: C, token: string) => `${appUrl(c)}/s/${token}`;
const orgName = (c: C) => clip(c.env.ORG_NAME, 80);

async function sha256(buf: ArrayBuffer | Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function who(c: C) {
  const id = c.req.header("x-altstack-owner-id");
  if (!id) return null;
  let name = "";
  try { name = decodeURIComponent(c.req.header("x-altstack-owner-name") || ""); } catch { /* keep empty */ }
  return {
    id,
    email: c.req.header("x-altstack-owner-email") || "",
    name,
    role: (c.req.header("x-altstack-role") || "member") as "owner" | "admin" | "member",
  };
}

function client(c: C) {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: clip(c.req.header("cf-connecting-ip") || fwd || c.req.header("x-real-ip") || "unknown", 64),
    ua: clip(c.req.header("user-agent") || "unknown", 400),
  };
}

async function logEvent(db: D1Database, e: { envelope_id: string; signer_id?: string | null; actor: string; action: string; detail?: string; ip?: string | null; ua?: string | null }) {
  await db.prepare("INSERT INTO events (envelope_id, signer_id, actor, action, detail, ip, user_agent, at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(e.envelope_id, e.signer_id ?? null, e.actor, e.action, e.detail ?? "", e.ip ?? null, e.ua ?? null, now()).run();
}

type EnvelopeRow = {
  id: string; title: string; message: string; status: string; pdf_key: string; file_name: string; pages: string;
  original_sha256: string; signed_key: string | null; signed_sha256: string | null;
  created_by_id: string; created_by_name: string; created_by_email: string;
  created_at: number; sent_at: number | null; completed_at: number | null; updated_at: number;
};
type SignerRow = {
  id: string; envelope_id: string; position: number; name: string; email: string; color: string; token: string; status: string;
  sent_at: number | null; viewed_at: number | null; signed_at: number | null; declined_reason: string | null;
  ip: string | null; user_agent: string | null; signature: string | null; initials: string | null;
};
type FieldRow = { id: string; envelope_id: string; signer_id: string; type: string; page: number; x: number; y: number; w: number; h: number; required: number; label: string; value: string | null };

const getEnvelope = (db: D1Database, id: string) => db.prepare("SELECT * FROM envelopes WHERE id = ?").bind(id).first<EnvelopeRow>();
const getSigners = async (db: D1Database, id: string) => (await db.prepare("SELECT * FROM signers WHERE envelope_id = ? ORDER BY position").bind(id).all<SignerRow>()).results;
const getFields = async (db: D1Database, id: string) => (await db.prepare("SELECT * FROM fields WHERE envelope_id = ? ORDER BY page, y, x").bind(id).all<FieldRow>()).results;

function publicSigner(c: C, s: SignerRow, includeLink: boolean) {
  return {
    id: s.id, position: s.position, name: s.name, email: s.email, color: s.color, status: s.status,
    sent_at: s.sent_at, viewed_at: s.viewed_at, signed_at: s.signed_at, declined_reason: s.declined_reason,
    ip: s.ip, user_agent: s.user_agent,
    link: includeLink && s.status !== "pending" ? signLink(c, s.token) : null,
  };
}
const publicField = (f: FieldRow) => ({ id: f.id, signer_id: f.signer_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: !!f.required, label: f.label, value: f.value });
const publicEnvelope = (e: EnvelopeRow) => ({
  id: e.id, title: e.title, message: e.message, status: e.status, file_name: e.file_name, pages: JSON.parse(e.pages),
  original_sha256: e.original_sha256, signed_sha256: e.signed_sha256, created_by_name: e.created_by_name, created_by_email: e.created_by_email,
  created_at: e.created_at, sent_at: e.sent_at, completed_at: e.completed_at, updated_at: e.updated_at,
});

async function readPdf(bytes: ArrayBuffer) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => { const b = p.getCropBox(); return { w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100 }; });
}

// ---------- pages ----------
const shell = (c: C, entry: "app" | "sign", data: Record<string, unknown>, title = "Inkpact") => c.html(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css?v=${V}">
</head><body>
<div id="root" class="boot"><div class="spinner"></div></div>
<script id="boot-data" type="application/json">${raw(JSON.stringify(data).replace(/</g, "\\u003c"))}</script>
<script type="module" src="/assets/${entry}.js?v=${V}"></script>
</body></html>`);

app.get("/healthz", (c) => c.json({ ok: true, version: V }));

app.get("/", (c) => {
  const me = who(c);
  if (me) return shell(c, "app", { me, org: orgName(c) });
  return c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inkpact — free e-signatures</title><link rel="icon" href="/assets/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/app.css?v=${V}"></head>
<body class="landing"><main class="land">
  <div class="brand big"><img src="/assets/icon.svg" alt="" width="40" height="40"><span>Inkpact</span></div>
  <h1>Get documents signed, free.</h1>
  <p>Upload a PDF, drop in signature, initials, date and text fields, and send each signer a private link. Watch the status change as they view and sign, then download the signed PDF with a full audit trail.</p>
  <a class="btn primary lg" href="/_altstack/login?next=/">Sign in to ${orgName(c) || "Inkpact"}</a>
  <p class="fine">Got a signing link? Open it directly; signers don't need an account.</p>
</main></body></html>`);
});

// Every other app page is the same single-page app.
for (const path of ["/e/:id", "/e/:id/edit", "/templates", "/new"]) {
  app.get(path, (c) => {
    const me = who(c);
    if (!me) return c.redirect(`/_altstack/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);
    return shell(c, "app", { me, org: orgName(c) });
  });
}

// ---------- signed-in API ----------
const api = new Hono<{ Bindings: Env; Variables: { me: NonNullable<ReturnType<typeof who>> } }>();
api.use("*", async (c, next) => {
  const me = who(c as unknown as C);
  if (!me) return c.json({ error: "Sign in first" }, 401);
  c.set("me", me);
  await next();
});

api.get("/me", (c) => c.json({ me: c.get("me"), org: orgName(c as unknown as C) }));

api.get("/envelopes", async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare("SELECT * FROM envelopes ORDER BY updated_at DESC LIMIT 500").all<EnvelopeRow>();
  const { results: signers } = await db.prepare(
    "SELECT envelope_id, id, name, email, color, status, position FROM signers WHERE envelope_id IN (SELECT id FROM envelopes ORDER BY updated_at DESC LIMIT 500) ORDER BY position",
  ).all<SignerRow>();
  const by = new Map<string, unknown[]>();
  for (const s of signers) {
    if (!by.has(s.envelope_id)) by.set(s.envelope_id, []);
    by.get(s.envelope_id)!.push({ id: s.id, name: s.name, email: s.email, color: s.color, status: s.status });
  }
  return c.json({ envelopes: results.map((e) => ({ ...publicEnvelope(e), signers: by.get(e.id) ?? [] })) });
});

api.post("/envelopes", async (c) => {
  const me = c.get("me");
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: "Choose a PDF to upload" }, 400);
  if (file.size > MAX_PDF) return c.json({ error: "PDFs can be up to 15 MB" }, 413);
  const bytes = await file.arrayBuffer();
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-")) return c.json({ error: "That file isn't a PDF" }, 400);
  let pages: { w: number; h: number }[];
  try { pages = await readPdf(bytes); } catch { return c.json({ error: "This PDF can't be opened. If it's password-protected, remove the password and try again." }, 400); }
  if (!pages.length) return c.json({ error: "This PDF has no pages" }, 400);
  if (pages.length > 200) return c.json({ error: "PDFs can have up to 200 pages" }, 400);

  const id = newId();
  const key = `envelopes/${id}/original.pdf`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const name = clip(file.name || "document.pdf", 160);
  const title = clip(form.title, 160) || name.replace(/\.pdf$/i, "");
  const t = now();
  await c.env.DB.prepare(
    "INSERT INTO envelopes (id, title, status, pdf_key, file_name, pages, original_sha256, created_by_id, created_by_name, created_by_email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, title, "draft", key, name, JSON.stringify(pages), await sha256(bytes), me.id, me.name, me.email, t, t).run();
  await logEvent(c.env.DB, { envelope_id: id, actor: me.name || me.email || "Sender", action: "created", detail: `Uploaded ${name} (${pages.length} page${pages.length === 1 ? "" : "s"})` });
  return c.json({ id }, 201);
});

async function envelopeDetail(c: C, id: string) {
  const e = await getEnvelope(c.env.DB, id);
  if (!e) return null;
  const [signers, fields, events] = await Promise.all([
    getSigners(c.env.DB, id), getFields(c.env.DB, id),
    c.env.DB.prepare("SELECT at, actor, action, detail, ip, user_agent, signer_id FROM events WHERE envelope_id = ? ORDER BY at, id").bind(id).all(),
  ]);
  return { envelope: publicEnvelope(e), signers: signers.map((s) => publicSigner(c, s, true)), fields: fields.map(publicField), events: events.results };
}

api.get("/envelopes/:id", async (c) => {
  const d = await envelopeDetail(c as unknown as C, c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "Not found" }, 404);
});

api.get("/envelopes/:id/pdf", async (c) => {
  const e = await getEnvelope(c.env.DB, c.req.param("id"));
  if (!e) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.MEDIA.get(e.pdf_key);
  if (!obj) return c.json({ error: "The file is missing" }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=3600" } });
});

type FieldIn = { signer: number; type: string; page: number; x: number; y: number; w: number; h: number; required?: boolean; label?: string };
function cleanFields(raw: unknown, signerCount: number, pageCount: number): FieldIn[] | string {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 500) return "Too many fields (500 at most)";
  const out: FieldIn[] = [];
  for (const f of raw as Record<string, unknown>[]) {
    const type = String(f.type);
    const signer = Number(f.signer), page = Number(f.page);
    const n = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));
    if (!FIELD_TYPES.has(type)) return `Unknown field type ${type}`;
    if (!Number.isInteger(signer) || signer < 0 || signer >= signerCount) return "A field belongs to a signer that doesn't exist";
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) return "A field is on a page that doesn't exist";
    const w = Math.max(0.01, n(f.w)), h = Math.max(0.008, n(f.h));
    out.push({ signer, type, page, x: Math.min(n(f.x), 1 - w), y: Math.min(n(f.y), 1 - h), w, h, required: type === "checkbox" ? !!f.required : f.required !== false, label: clip(f.label, 80) });
  }
  return out;
}

api.put("/envelopes/:id", async (c) => {
  const id = c.req.param("id");
  const e = await getEnvelope(c.env.DB, id);
  if (!e) return c.json({ error: "Not found" }, 404);
  if (e.status !== "draft") return c.json({ error: "This envelope was already sent, so it can't be changed" }, 409);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Send JSON" }, 400);
  const signersIn = Array.isArray(body.signers) ? (body.signers as Record<string, unknown>[]) : [];
  if (signersIn.length > 20) return c.json({ error: "Up to 20 signers per envelope" }, 400);
  const pages = JSON.parse(e.pages) as unknown[];
  const fields = cleanFields(body.fields, signersIn.length, pages.length);
  if (typeof fields === "string") return c.json({ error: fields }, 400);

  const old = await getSigners(c.env.DB, id);
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE envelopes SET title = ?, message = ?, updated_at = ? WHERE id = ?").bind(clip(body.title, 160) || e.title, clip(body.message, 2000), now(), id),
    c.env.DB.prepare("DELETE FROM fields WHERE envelope_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM signers WHERE envelope_id = ?").bind(id),
  ];
  const ids: string[] = [];
  signersIn.forEach((s, i) => {
    const keep = old.find((o) => o.id === s.id);
    const sid = keep?.id ?? newId();
    ids.push(sid);
    stmts.push(c.env.DB.prepare("INSERT INTO signers (id, envelope_id, position, name, email, color, token) VALUES (?,?,?,?,?,?,?)")
      .bind(sid, id, i, clip(s.name, 120), clip(s.email, 254).toLowerCase(), COLORS.includes(String(s.color)) ? String(s.color) : COLORS[i % COLORS.length], keep?.token ?? randomToken()));
  });
  for (const f of fields) {
    stmts.push(c.env.DB.prepare("INSERT INTO fields (id, envelope_id, signer_id, type, page, x, y, w, h, required, label) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(newId(), id, ids[f.signer], f.type, f.page, f.x, f.y, f.w, f.h, f.required ? 1 : 0, f.label ?? ""));
  }
  await c.env.DB.batch(stmts);
  return c.json(await envelopeDetail(c as unknown as C, id));
});

api.post("/envelopes/:id/send", async (c) => {
  const me = c.get("me");
  const id = c.req.param("id");
  const cc = c as unknown as C;
  const e = await getEnvelope(c.env.DB, id);
  if (!e) return c.json({ error: "Not found" }, 404);
  if (e.status !== "draft") return c.json({ error: "This envelope was already sent" }, 409);
  const signers = await getSigners(c.env.DB, id);
  const fields = await getFields(c.env.DB, id);
  if (!signers.length) return c.json({ error: "Add at least one signer" }, 400);
  for (const s of signers) {
    if (!s.name) return c.json({ error: "Every signer needs a name" }, 400);
    if (!emailOk(s.email)) return c.json({ error: `${s.name}'s email address doesn't look right` }, 400);
    if (!fields.some((f) => f.signer_id === s.id && f.type === "signature")) return c.json({ error: `Place at least one signature field for ${s.name}` }, 400);
  }
  if (new Set(signers.map((s) => s.email)).size !== signers.length) return c.json({ error: "Each signer needs a different email address" }, 400);

  const t = now();
  const actor = me.name || me.email || "Sender";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE envelopes SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").bind(t, t, id),
    c.env.DB.prepare("UPDATE signers SET status = 'sent', sent_at = ? WHERE envelope_id = ?").bind(t, id),
  ]);
  await logEvent(c.env.DB, { envelope_id: id, actor, action: "sent", detail: `Sent to ${signers.map((s) => s.name).join(", ")}` });

  // Email each signer their link. The link is always shown in the app too, so mail is a convenience.
  const from = orgName(cc) || actor;
  const emailed: string[] = [];
  for (const s of signers) {
    try {
      await c.env.ALTSTACK.sendEmail({
        to: s.email,
        subject: `${from} sent you "${e.title}" to sign`,
        replyTo: emailOk(me.email) ? me.email : undefined,
        text: `Hi ${s.name},\n\n${from} has asked you to review and sign "${e.title}".${e.message ? `\n\nMessage:\n${e.message}` : ""}\n\nReview and sign:\n${signLink(cc, s.token)}\n\nThis link is just for you; please don't forward it.\n\nSent with Inkpact`,
      });
      emailed.push(s.email);
    } catch (err) {
      await c.env.ALTSTACK.log("warn", `Couldn't email ${s.email}: ${(err as Error).message}`).catch(() => {});
    }
  }
  if (emailed.length) await logEvent(c.env.DB, { envelope_id: id, actor: "Inkpact", action: "emailed", detail: `Signing links emailed to ${emailed.join(", ")}` });
  return c.json({ ...(await envelopeDetail(cc, id)), emailed });
});

api.post("/envelopes/:id/remind", async (c) => {
  const me = c.get("me");
  const cc = c as unknown as C;
  const e = await getEnvelope(c.env.DB, c.req.param("id"));
  if (!e) return c.json({ error: "Not found" }, 404);
  if (e.status !== "sent") return c.json({ error: "Only envelopes waiting for signatures can be reminded" }, 409);
  const waiting = (await getSigners(c.env.DB, e.id)).filter((s) => s.status === "sent" || s.status === "viewed");
  const from = orgName(cc) || me.name || me.email || "Someone";
  for (const s of waiting) {
    await c.env.ALTSTACK.sendEmail({ to: s.email, subject: `Reminder: please sign "${e.title}"`, text: `Hi ${s.name},\n\n${from} is waiting for your signature on "${e.title}".\n\nReview and sign:\n${signLink(cc, s.token)}\n\nSent with Inkpact` }).catch(() => {});
  }
  await logEvent(c.env.DB, { envelope_id: e.id, actor: me.name || me.email || "Sender", action: "reminded", detail: waiting.map((s) => s.name).join(", ") || "nobody waiting" });
  return c.json({ reminded: waiting.length });
});

api.post("/envelopes/:id/void", async (c) => {
  const me = c.get("me");
  const e = await getEnvelope(c.env.DB, c.req.param("id"));
  if (!e) return c.json({ error: "Not found" }, 404);
  if (me.role === "member" && e.created_by_id !== me.id) return c.json({ error: "Only the sender or an admin can void this" }, 403);
  if (e.status !== "sent") return c.json({ error: "Only envelopes waiting for signatures can be voided" }, 409);
  const reason = clip((await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })).reason, 300);
  await c.env.DB.prepare("UPDATE envelopes SET status = 'voided', updated_at = ? WHERE id = ?").bind(now(), e.id).run();
  await logEvent(c.env.DB, { envelope_id: e.id, actor: me.name || me.email || "Sender", action: "voided", detail: reason });
  return c.json({ ok: true });
});

api.delete("/envelopes/:id", async (c) => {
  const me = c.get("me");
  const e = await getEnvelope(c.env.DB, c.req.param("id"));
  if (!e) return c.json({ error: "Not found" }, 404);
  if (me.role === "member" && e.created_by_id !== me.id) return c.json({ error: "Only the sender or an admin can delete this" }, 403);
  if (e.status === "sent") return c.json({ error: "Void the envelope before deleting it" }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM events WHERE envelope_id = ?").bind(e.id),
    c.env.DB.prepare("DELETE FROM fields WHERE envelope_id = ?").bind(e.id),
    c.env.DB.prepare("DELETE FROM signers WHERE envelope_id = ?").bind(e.id),
    c.env.DB.prepare("DELETE FROM envelopes WHERE id = ?").bind(e.id),
  ]);
  await c.env.MEDIA.delete([e.pdf_key, ...(e.signed_key ? [e.signed_key] : [])]);
  return c.json({ ok: true });
});

async function signedPdfResponse(c: C, e: EnvelopeRow) {
  if (e.status !== "completed" || !e.signed_key) return c.json({ error: "The document isn't finished yet" }, 409);
  const obj = await c.env.MEDIA.get(e.signed_key);
  if (!obj) return c.json({ error: "The signed file is missing" }, 404);
  const name = `${e.title.replace(/[^\w\- ]+/g, "").trim() || "document"} (signed).pdf`;
  return new Response(obj.body, {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" },
  });
}

api.get("/envelopes/:id/signed.pdf", async (c) => {
  const e = await getEnvelope(c.env.DB, c.req.param("id"));
  return e ? signedPdfResponse(c as unknown as C, e) : c.json({ error: "Not found" }, 404);
});

// ---------- templates ----------
api.get("/templates", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, file_name, pages, roles, fields, message, created_by_name, created_at FROM templates ORDER BY created_at DESC").all<Record<string, string>>();
  return c.json({ templates: results.map((t) => ({ ...t, pages: JSON.parse(t.pages), roles: JSON.parse(t.roles), field_count: JSON.parse(t.fields).length, fields: undefined })) });
});

api.post("/templates", async (c) => {
  const me = c.get("me");
  const body = await c.req.json<{ envelope_id?: string; name?: string }>().catch(() => ({}) as { envelope_id?: string; name?: string });
  const e = body.envelope_id ? await getEnvelope(c.env.DB, body.envelope_id) : null;
  if (!e) return c.json({ error: "Pick an envelope to save as a template" }, 400);
  const signers = await getSigners(c.env.DB, e.id);
  const fields = await getFields(c.env.DB, e.id);
  if (!signers.length || !fields.length) return c.json({ error: "Add signers and fields first" }, 400);
  const id = newId();
  const key = `templates/${id}.pdf`;
  const obj = await c.env.MEDIA.get(e.pdf_key);
  if (!obj) return c.json({ error: "The file is missing" }, 404);
  await c.env.MEDIA.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: "application/pdf" } });
  const roles = signers.map((s, i) => ({ name: `Signer ${i + 1}`, color: s.color }));
  const pos = new Map(signers.map((s, i) => [s.id, i]));
  const tf = fields.map((f) => ({ role: pos.get(f.signer_id) ?? 0, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: !!f.required, label: f.label }));
  await c.env.DB.prepare("INSERT INTO templates (id, name, pdf_key, file_name, pages, roles, fields, message, created_by_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, clip(body.name, 120) || e.title, key, e.file_name, e.pages, JSON.stringify(roles), JSON.stringify(tf), e.message, me.name || me.email, now()).run();
  return c.json({ id }, 201);
});

api.post("/templates/:id/use", async (c) => {
  const me = c.get("me");
  const t = await c.env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(c.req.param("id")).first<Record<string, string>>();
  if (!t) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.MEDIA.get(t.pdf_key);
  if (!obj) return c.json({ error: "The template's file is missing" }, 404);
  const bytes = await obj.arrayBuffer();
  const id = newId();
  const key = `envelopes/${id}/original.pdf`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const roles = JSON.parse(t.roles) as { name: string; color: string }[];
  const fields = JSON.parse(t.fields) as (FieldIn & { role: number })[];
  const ts = now();
  const sids = roles.map(() => newId());
  const stmts = [
    c.env.DB.prepare("INSERT INTO envelopes (id, title, message, status, pdf_key, file_name, pages, original_sha256, created_by_id, created_by_name, created_by_email, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, t.name, t.message, "draft", key, t.file_name, t.pages, await sha256(bytes), me.id, me.name, me.email, ts, ts),
    ...roles.map((r, i) => c.env.DB.prepare("INSERT INTO signers (id, envelope_id, position, name, email, color, token) VALUES (?,?,?,?,?,?,?)").bind(sids[i], id, i, "", "", r.color, randomToken())),
    ...fields.map((f) => c.env.DB.prepare("INSERT INTO fields (id, envelope_id, signer_id, type, page, x, y, w, h, required, label) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(newId(), id, sids[f.role] ?? sids[0], f.type, f.page, f.x, f.y, f.w, f.h, f.required ? 1 : 0, f.label ?? "")),
  ];
  await c.env.DB.batch(stmts);
  await logEvent(c.env.DB, { envelope_id: id, actor: me.name || me.email || "Sender", action: "created", detail: `From template "${t.name}"` });
  return c.json({ id }, 201);
});

api.delete("/templates/:id", async (c) => {
  const me = c.get("me");
  if (me.role === "member") return c.json({ error: "Only owners and admins can delete templates" }, 403);
  const t = await c.env.DB.prepare("SELECT pdf_key FROM templates WHERE id = ?").bind(c.req.param("id")).first<{ pdf_key: string }>();
  if (!t) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(c.req.param("id")).run();
  await c.env.MEDIA.delete(t.pdf_key);
  return c.json({ ok: true });
});

app.route("/api", api);

// ---------- public signing (no account) ----------
async function signerByToken(c: C) {
  const token = c.req.param("token") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const s = await c.env.DB.prepare("SELECT * FROM signers WHERE token = ?").bind(token).first<SignerRow>();
  if (!s) return null;
  const e = await getEnvelope(c.env.DB, s.envelope_id);
  if (!e || e.status === "draft") return null;
  return { s, e };
}

async function limited(c: C, what: string) {
  if (!c.env.SIGN_LIMIT) return false;
  const { success } = await c.env.SIGN_LIMIT.limit({ key: `${what}:${client(c).ip}` });
  return !success;
}

const notFoundPage = (c: C) => c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found · Inkpact</title><link rel="stylesheet" href="/assets/app.css?v=${V}"></head>
<body class="landing"><main class="land"><div class="brand big"><img src="/assets/icon.svg" alt="" width="40" height="40"><span>Inkpact</span></div><h1>This signing link doesn't work</h1><p>It may have been mistyped, or the sender may have withdrawn the document. Ask the sender for a new link.</p></main></body></html>`, 404);

app.get("/s/:token", async (c) => {
  const found = await signerByToken(c);
  if (!found) return notFoundPage(c);
  return shell(c, "sign", { token: c.req.param("token") }, `Sign: ${found.e.title}`);
});

app.get("/s/:token/data", async (c) => {
  if (await limited(c, "view")) return c.json({ error: "Too many requests, wait a minute" }, 429);
  const found = await signerByToken(c);
  if (!found) return c.json({ error: "This link doesn't work" }, 404);
  let { s } = found;
  const { e } = found;
  if (e.status === "sent" && s.status === "sent") {
    const { ip, ua } = client(c);
    const t = now();
    await c.env.DB.prepare("UPDATE signers SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'").bind(t, s.id).run();
    await c.env.DB.prepare("UPDATE envelopes SET updated_at = ? WHERE id = ?").bind(t, e.id).run();
    await logEvent(c.env.DB, { envelope_id: e.id, signer_id: s.id, actor: s.name, action: "viewed", detail: s.email, ip, ua });
    s = { ...s, status: "viewed", viewed_at: t };
  }
  const all = await getSigners(c.env.DB, e.id);
  const fields = (await getFields(c.env.DB, e.id)).map(publicField);
  const signedBy = new Map(all.filter((o) => o.status === "signed").map((o) => [o.id, o]));
  return c.json({
    envelope: { title: e.title, message: e.message, status: e.status, pages: JSON.parse(e.pages), file_name: e.file_name, sender: orgName(c) || e.created_by_name || e.created_by_email, sender_email: e.created_by_email, completed_at: e.completed_at },
    me: { id: s.id, name: s.name, email: s.email, color: s.color, status: s.status, signed_at: s.signed_at, signature: s.signature, initials: s.initials },
    others: all.filter((o) => o.id !== s.id).map((o) => ({ id: o.id, name: o.name, color: o.color, status: o.status })),
    // Other signers' fields are shown only once they've signed, read-only.
    fields: fields.filter((f) => f.signer_id === s.id || signedBy.has(f.signer_id)),
    signatures: Object.fromEntries([...signedBy].map(([id, o]) => [id, { signature: o.signature, initials: o.initials }])),
  });
});

app.get("/s/:token/pdf", async (c) => {
  const found = await signerByToken(c);
  if (!found) return c.json({ error: "This link doesn't work" }, 404);
  const obj = await c.env.MEDIA.get(found.e.pdf_key);
  if (!obj) return c.json({ error: "The file is missing" }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=3600" } });
});

app.get("/s/:token/signed.pdf", async (c) => {
  const found = await signerByToken(c);
  if (!found) return c.json({ error: "This link doesn't work" }, 404);
  return signedPdfResponse(c, found.e);
});

const pngOk = (v: unknown): v is string => typeof v === "string" && v.startsWith("data:image/png;base64,") && v.length <= MAX_IMAGE;

app.post("/s/:token/sign", async (c) => {
  if (await limited(c, "sign")) return c.json({ error: "Too many requests, wait a minute" }, 429);
  const found = await signerByToken(c);
  if (!found) return c.json({ error: "This link doesn't work" }, 404);
  const { s, e } = found;
  if (e.status !== "sent") return c.json({ error: `This document is ${e.status}, so it can't be signed` }, 409);
  if (s.status === "signed") return c.json({ error: "You've already signed" }, 409);
  if (s.status === "declined") return c.json({ error: "You declined to sign this document" }, 409);
  const len = Number(c.req.header("content-length") || 0);
  if (len > 1_200_000) return c.json({ error: "Too large" }, 413);
  const body = await c.req.json<{ consent?: boolean; signature?: string; initials?: string; values?: Record<string, unknown>; tz?: string }>().catch(() => null);
  if (!body) return c.json({ error: "Send JSON" }, 400);
  if (body.consent !== true) return c.json({ error: "Agree to sign electronically first" }, 400);

  const mine = (await getFields(c.env.DB, e.id)).filter((f) => f.signer_id === s.id);
  const needSig = mine.some((f) => f.type === "signature"), needIni = mine.some((f) => f.type === "initials");
  if (needSig && !pngOk(body.signature)) return c.json({ error: "Add your signature" }, 400);
  if (needIni && !pngOk(body.initials)) return c.json({ error: "Add your initials" }, 400);

  let tz = "UTC";
  try { if (body.tz) { new Intl.DateTimeFormat("en-US", { timeZone: String(body.tz) }); tz = String(body.tz).slice(0, 64); } } catch { /* keep UTC */ }
  const t = now();
  const dateText = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric" }).format(t);
  const values = body.values && typeof body.values === "object" ? body.values : {};
  const updates: D1PreparedStatement[] = [];
  for (const f of mine) {
    let v: string | null = null;
    if (f.type === "signature" || f.type === "initials") v = "signed";
    else if (f.type === "date") v = dateText;
    else if (f.type === "name") v = clip(values[f.id] ?? s.name, 120) || s.name;
    else if (f.type === "text") v = clip(values[f.id], 500) || null;
    else if (f.type === "checkbox") v = values[f.id] === true || values[f.id] === "true" ? "true" : "false";
    if (f.required && (v == null || (f.type === "checkbox" && v !== "true"))) {
      return c.json({ error: `Fill in ${f.label || `the ${f.type} field`} on page ${f.page + 1}` }, 400);
    }
    updates.push(c.env.DB.prepare("UPDATE fields SET value = ? WHERE id = ?").bind(v, f.id));
  }
  const { ip, ua } = client(c);
  updates.push(
    c.env.DB.prepare("UPDATE signers SET status = 'signed', signed_at = ?, ip = ?, user_agent = ?, signature = ?, initials = ?, viewed_at = COALESCE(viewed_at, ?) WHERE id = ?")
      .bind(t, ip, ua, needSig ? body.signature! : null, needIni ? body.initials! : null, t, s.id),
    c.env.DB.prepare("UPDATE envelopes SET updated_at = ? WHERE id = ?").bind(t, e.id),
  );
  await c.env.DB.batch(updates);
  await logEvent(c.env.DB, { envelope_id: e.id, signer_id: s.id, actor: s.name, action: "signed", detail: `${s.email} agreed to sign electronically and signed`, ip, ua });

  const remaining = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM signers WHERE envelope_id = ? AND status != 'signed'").bind(e.id).first<{ n: number }>();
  if (!remaining?.n) {
    // Build the signed PDF now so the signer can download it straight away.
    await complete(c, e.id);
  } else {
    await maybeNotifySender(c, e, `${s.name} signed "${e.title}"`, `${s.name} (${s.email}) signed "${e.title}". ${remaining.n} signer${remaining.n === 1 ? " is" : "s are"} still to sign.`);
  }
  return c.json({ ok: true, completed: !remaining?.n });
});

app.post("/s/:token/decline", async (c) => {
  if (await limited(c, "sign")) return c.json({ error: "Too many requests, wait a minute" }, 429);
  const found = await signerByToken(c);
  if (!found) return c.json({ error: "This link doesn't work" }, 404);
  const { s, e } = found;
  if (e.status !== "sent" || s.status === "signed") return c.json({ error: "This document can't be declined now" }, 409);
  const reason = clip((await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })).reason, 500);
  const { ip, ua } = client(c);
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE signers SET status = 'declined', declined_reason = ?, ip = ?, user_agent = ? WHERE id = ?").bind(reason, ip, ua, s.id),
    c.env.DB.prepare("UPDATE envelopes SET status = 'declined', updated_at = ? WHERE id = ?").bind(t, e.id),
  ]);
  await logEvent(c.env.DB, { envelope_id: e.id, signer_id: s.id, actor: s.name, action: "declined", detail: reason, ip, ua });
  await maybeNotifySender(c, e, `${s.name} declined to sign "${e.title}"`, `${s.name} (${s.email}) declined to sign "${e.title}".${reason ? `\n\nReason: ${reason}` : ""}`);
  return c.json({ ok: true });
});

async function maybeNotifySender(c: C, e: EnvelopeRow, subject: string, text: string) {
  if (!emailOk(e.created_by_email)) return;
  await c.env.ALTSTACK.sendEmail({ to: e.created_by_email, subject, text: `${text}\n\nSee the status: ${appUrl(c)}/e/${e.id}\n\nInkpact` }).catch(() => {});
}

async function complete(c: C, id: string) {
  const e = await getEnvelope(c.env.DB, id);
  if (!e || e.status !== "sent") return;
  const t = now();
  // Claim the envelope so two last signatures can't both build the PDF.
  const claim = await c.env.DB.prepare("UPDATE envelopes SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'").bind(t, t, id).run();
  if (!claim.meta.changes) return;
  await logEvent(c.env.DB, { envelope_id: id, actor: "Inkpact", action: "completed", detail: "All signers signed" });
  const [signers, fields, events] = await Promise.all([
    getSigners(c.env.DB, id), getFields(c.env.DB, id),
    c.env.DB.prepare("SELECT at, actor, action, detail, ip FROM events WHERE envelope_id = ? ORDER BY at, id").bind(id).all<{ at: number; actor: string; action: string; detail: string; ip: string | null }>(),
  ]);
  const original = await c.env.MEDIA.get(e.pdf_key);
  if (!original) throw new Error("original PDF missing");
  const pdf = await buildSignedPdf(await original.arrayBuffer(), { ...e, completed_at: t }, signers, fields, events.results);
  const key = `envelopes/${id}/signed.pdf`;
  await c.env.MEDIA.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
  await c.env.DB.prepare("UPDATE envelopes SET signed_key = ?, signed_sha256 = ? WHERE id = ?").bind(key, await sha256(pdf), id).run();

  const mail = async () => {
    for (const s of signers) {
      await c.env.ALTSTACK.sendEmail({
        to: s.email, subject: `Completed: "${e.title}"`,
        text: `Hi ${s.name},\n\nEveryone has signed "${e.title}". Download the signed copy with its audit trail:\n${signLink(c, s.token)}\n\nSent with Inkpact`,
      }).catch(() => {});
    }
    await maybeNotifySender(c, e, `Completed: "${e.title}"`, `Everyone has signed "${e.title}". The signed PDF with its certificate of completion is ready.`);
  };
  c.executionCtx.waitUntil(mail());
}

// ---------- AI tools (declared in altstack.json) ----------
app.post("/_altstack/tools/list_envelopes", async (c) => {
  if (!who(c)) return c.json({ error: "Sign in first" }, 401);
  const { status, limit } = await c.req.json<{ status?: string; limit?: number }>().catch(() => ({}) as { status?: string; limit?: number });
  const n = Math.min(100, Math.max(1, Number(limit) || 25));
  const q = status
    ? c.env.DB.prepare("SELECT id, title, status, sent_at, completed_at FROM envelopes WHERE status = ? ORDER BY updated_at DESC LIMIT ?").bind(String(status), n)
    : c.env.DB.prepare("SELECT id, title, status, sent_at, completed_at FROM envelopes ORDER BY updated_at DESC LIMIT ?").bind(n);
  return c.json({ envelopes: (await q.all()).results });
});

app.post("/_altstack/tools/get_envelope_status", async (c) => {
  if (!who(c)) return c.json({ error: "Sign in first" }, 401);
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  if (!id) return c.json({ error: "id is required (from list_envelopes)" }, 400);
  const e = await getEnvelope(c.env.DB, String(id));
  if (!e) return c.json({ error: "No envelope with that id" }, 404);
  const signers = await getSigners(c.env.DB, e.id);
  return c.json({
    id: e.id, title: e.title, status: e.status, sent_at: e.sent_at, completed_at: e.completed_at,
    signers: signers.map((s) => ({ name: s.name, email: s.email, status: s.status, viewed_at: s.viewed_at, signed_at: s.signed_at })),
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError(async (err, c) => {
  await c.env.ALTSTACK?.log("error", err.message).catch(() => {});
  return c.json({ error: "Something went wrong. Try again." }, 500);
});

export default app;
