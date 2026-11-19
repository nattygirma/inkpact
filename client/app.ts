// The sender's app: envelopes, the field editor, status pages and templates.
import { h, set, svg, icons, api, toast, modal, confirmDialog, promptDialog, copyText, fmtDate, fmtDateTime, timeAgo, initialsOf, pill, signerPill, FIELD_META, brand, bootData, STATUS_LABEL } from "./ui";
import { renderPdf, type PageBox } from "./pdf";

type Me = { id: string; email: string; name: string; role: "owner" | "admin" | "member" };
const boot = bootData<{ me: Me; org: string }>();
const me = boot.me;
const root = document.getElementById("root")!;
const COLORS = ["#0e7c66", "#6d4bd8", "#d9480f", "#1c7ed6", "#c2255c", "#5c940d", "#e67700", "#0b7285"];

type Signer = { id: string; position: number; name: string; email: string; color: string; status: string; sent_at: number | null; viewed_at: number | null; signed_at: number | null; declined_reason: string | null; ip: string | null; user_agent: string | null; link: string | null };
type Field = { id: string; signer_id: string; type: string; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value: string | null };
type Envelope = { id: string; title: string; message: string; status: string; file_name: string; pages: { w: number; h: number }[]; original_sha256: string; signed_sha256: string | null; created_by_name: string; created_by_email: string; created_at: number; sent_at: number | null; completed_at: number | null; updated_at: number };
type Detail = { envelope: Envelope; signers: Signer[]; fields: Field[]; events: { at: number; actor: string; action: string; detail: string; ip: string | null; user_agent: string | null; signer_id: string | null }[] };
type ListItem = Envelope & { signers: { id: string; name: string; email: string; color: string; status: string }[] };

let cleanup: (() => void) | null = null;

// ---------- routing ----------
function go(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  void route();
}
window.addEventListener("popstate", () => void route());
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[data-nav]") as HTMLAnchorElement | null;
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute("href")!);
});

async function route() {
  cleanup?.(); cleanup = null;
  const p = location.pathname;
  root.className = "";
  let m: RegExpMatchArray | null;
  try {
    if ((m = p.match(/^\/e\/([\w-]+)\/edit$/))) await editor(m[1]!);
    else if ((m = p.match(/^\/e\/([\w-]+)$/))) await detail(m[1]!);
    else if (p === "/templates") await templates();
    else await dashboard();
  } catch (err) {
    set(root, frame("", h("div", { class: "empty" }, h("h2", null, "Something went wrong"), h("p", null, (err as Error).message), h("a", { class: "btn", href: "/", "data-nav": "" }, "Back to envelopes"))));
  }
  window.scrollTo(0, 0);
}

function frame(active: string, ...content: (Node | null)[]) {
  const nav = (href: string, label: string, icon: string, key: string) =>
    h("a", { href, "data-nav": "", class: `nav-link${active === key ? " on" : ""}` }, svg(icon, 17), label);
  return h("div", { class: "shell" },
    h("header", { class: "topbar" },
      brand(boot.org),
      h("nav", { class: "nav" }, nav("/", "Envelopes", icons.doc, "envelopes"), nav("/templates", "Templates", icons.template, "templates")),
      h("div", { class: "me" }, h("span", { class: "avatar", style: { background: "#14213d" } }, initialsOf(me.name || me.email)), h("div", { class: "me-text" }, h("b", null, me.name || me.email || "You"), h("small", null, me.role)))),
    h("main", { class: "main" }, ...content));
}

// ---------- uploading ----------
function pickPdf(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: "application/pdf,.pdf", style: { display: "none" } });
    input.addEventListener("change", () => { resolve(input.files?.[0] ?? null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

async function uploadPdf(file: File) {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { toast("Choose a PDF file", "err"); return; }
  const fd = new FormData();
  fd.append("file", file);
  toast("Uploading…", "info");
  try {
    const { id } = await api<{ id: string }>("/api/envelopes", { method: "POST", body: fd });
    go(`/e/${id}/edit`);
  } catch (err) { toast((err as Error).message, "err"); }
}

function dropzone() {
  const input = h("input", { type: "file", accept: "application/pdf,.pdf", class: "visually-hidden", id: "pdf-input", "aria-label": "Upload a PDF" });
  input.addEventListener("change", () => { const f = input.files?.[0]; if (f) void uploadPdf(f); });
  const zone = h("label", { class: "dropzone", for: "pdf-input" },
    h("div", { class: "dz-icon" }, svg(icons.upload, 26)),
    h("div", null, h("b", null, "Upload a PDF to start"), h("p", null, "Drop it here or click to choose a file. Up to 15 MB.")),
    h("span", { class: "btn primary" }, svg(icons.plus, 16), "New envelope"), input);
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); const f = e.dataTransfer?.files?.[0]; if (f) void uploadPdf(f); });
  return zone;
}

// ---------- dashboard ----------
async function dashboard() {
  set(root, frame("envelopes", h("div", { class: "loading" }, h("div", { class: "spinner" }))));
  const { envelopes } = await api<{ envelopes: ListItem[] }>("/api/envelopes");
  let filter = new URLSearchParams(location.search).get("f") || "all";
  const count = (s: string) => envelopes.filter((e) => e.status === s).length;
  const stat = (key: string, label: string, n: number, icon: string) =>
    h("button", { class: `stat${filter === key ? " on" : ""}`, onclick: () => { filter = filter === key ? "all" : key; draw(); } },
      h("span", { class: `stat-ico s-${key}` }, svg(icon, 18)), h("div", null, h("b", null, String(n)), h("small", null, label)));

  const listWrap = h("div");
  const statsWrap = h("div", { class: "stats" });
  const draw = () => {
    history.replaceState(null, "", filter === "all" ? "/" : `/?f=${filter}`);
    set(statsWrap, 
      stat("sent", "Waiting for others", count("sent"), icons.clock),
      stat("completed", "Completed", count("completed"), icons.check),
      stat("draft", "Drafts", count("draft"), icons.doc),
      stat("declined", "Declined or voided", count("declined") + count("voided"), icons.ban));
    const rows = envelopes.filter((e) => filter === "all" || e.status === filter || (filter === "declined" && e.status === "voided"));
    if (!envelopes.length) {
      set(listWrap, h("div", { class: "empty" }, h("div", { class: "empty-art" }, svg(icons.pen, 34)), h("h2", null, "No envelopes yet"), h("p", null, "Upload a PDF above to send your first document for signature.")));
      return;
    }
    set(listWrap, h("div", { class: "card table-card" },
      h("div", { class: "table-head" }, h("h2", null, filter === "all" ? "All envelopes" : STATUS_LABEL[filter] ?? filter), filter !== "all" ? h("button", { class: "link-btn", onclick: () => { filter = "all"; draw(); } }, "Show all") : null),
      rows.length ? h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Document"), h("th", null, "Signers"), h("th", null, "Status"), h("th", { class: "right" }, "Last change"))),
        h("tbody", null, rows.map((e) => {
          const href = e.status === "draft" ? `/e/${e.id}/edit` : `/e/${e.id}`;
          const signed = e.signers.filter((s) => s.status === "signed").length;
          return h("tr", { onclick: () => go(href), class: "row-link" },
            h("td", null, h("a", { href, "data-nav": "", class: "doc-cell" }, h("span", { class: "doc-ico" }, svg(icons.doc, 18)), h("div", null, h("b", null, e.title), h("small", null, `${e.pages.length} page${e.pages.length === 1 ? "" : "s"} · ${e.created_by_name || e.created_by_email || ""}`)))),
            h("td", null, h("div", { class: "avatars" }, e.signers.slice(0, 5).map((s) => h("span", { class: `avatar sm st-${s.status}`, style: { background: s.color }, title: `${s.name || "Unnamed"}: ${STATUS_LABEL[s.status] ?? s.status}` }, initialsOf(s.name || "?"))), e.signers.length ? h("small", { class: "muted" }, e.status === "draft" ? `${e.signers.length} signer${e.signers.length === 1 ? "" : "s"}` : `${signed}/${e.signers.length} signed`) : h("small", { class: "muted" }, "No signers yet"))),
            h("td", null, pill(e.status)),
            h("td", { class: "right muted" }, timeAgo(e.updated_at)));
        }))) : h("p", { class: "muted pad" }, "Nothing here.")));
  };
  draw();
  set(root, frame("envelopes",
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Envelopes"), h("p", { class: "muted" }, "Send documents for signature and track every signer."))),
    dropzone(), statsWrap, listWrap));
}

// ---------- editor ----------
type EdSigner = { id?: string; name: string; email: string; color: string };
type EdField = { key: string; signer: number; type: string; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string };

async function editor(id: string) {
  set(root, h("div", { class: "loading full" }, h("div", { class: "spinner" })));
  const d = await api<Detail>(`/api/envelopes/${id}`);
  if (d.envelope.status !== "draft") { go(`/e/${id}`, true); return; }
  const env = d.envelope;
  let k = 0;
  const signers: EdSigner[] = d.signers.map((s) => ({ id: s.id, name: s.name, email: s.email, color: s.color }));
  const fields: EdField[] = d.fields.map((f) => ({ key: `f${k++}`, signer: Math.max(0, d.signers.findIndex((s) => s.id === f.signer_id)), type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label }));
  if (!signers.length) signers.push({ name: "", email: "", color: COLORS[0]! });
  let active = 0;
  let selected: string | null = null;
  let placing: string | null = null;
  let dirty = false;
  let saving: Promise<void> | null = null;
  let title = env.title, message = env.message;

  const status = h("span", { class: "save-state" }, "Saved");
  const markDirty = () => { dirty = true; status.textContent = "Unsaved changes"; status.className = "save-state dirty"; scheduleSave(); };
  let timer: number | undefined;
  const scheduleSave = () => { clearTimeout(timer); timer = window.setTimeout(() => void save(), 900); };
  async function save() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return;
    dirty = false;
    status.textContent = "Saving…"; status.className = "save-state";
    saving = (async () => {
      try {
        const r = await api<Detail>(`/api/envelopes/${id}`, { method: "PUT", json: {
          title, message,
          signers: signers.map((s) => ({ id: s.id, name: s.name, email: s.email, color: s.color })),
          fields: fields.map((f) => ({ signer: f.signer, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label })),
        } });
        r.signers.forEach((s, i) => { if (signers[i]) signers[i]!.id = s.id; });
        status.textContent = "Saved"; status.className = "save-state";
      } catch (err) { dirty = true; status.textContent = "Couldn't save"; status.className = "save-state err"; toast((err as Error).message, "err"); }
    })();
    await saving; saving = null;
  }

  // Left: signers and the field palette.
  const signerList = h("div", { class: "signers" });
  const palette = h("div", { class: "palette" });
  const drawSigners = () => {
    set(signerList, ...signers.map((s, i) => {
      const nameIn = h("input", { class: "input", placeholder: "Full name", value: s.name, maxlength: 120, "aria-label": `Signer ${i + 1} name` });
      const emailIn = h("input", { class: "input", placeholder: "email@example.com", type: "email", value: s.email, maxlength: 254, "aria-label": `Signer ${i + 1} email` });
      nameIn.addEventListener("input", () => { s.name = nameIn.value; markDirty(); drawFields(); });
      emailIn.addEventListener("input", () => { s.email = emailIn.value.trim(); markDirty(); });
      const n = fields.filter((f) => f.signer === i).length;
      return h("div", { class: `signer${active === i ? " on" : ""}`, style: { "--c": s.color }, onclick: (e: Event) => { if ((e.target as HTMLElement).tagName !== "INPUT" && !(e.target as HTMLElement).closest("button")) { active = i; drawSigners(); drawPalette(); } } },
        h("div", { class: "signer-top" },
          h("span", { class: "dot", style: { background: s.color } }),
          h("b", null, `Signer ${i + 1}`),
          h("small", { class: "muted" }, `${n} field${n === 1 ? "" : "s"}`),
          signers.length > 1 ? h("button", { class: "icon-btn sm", "aria-label": `Remove signer ${i + 1}`, onclick: () => {
            for (let j = fields.length - 1; j >= 0; j--) { if (fields[j]!.signer === i) fields.splice(j, 1); else if (fields[j]!.signer > i) fields[j]!.signer--; }
            signers.splice(i, 1); active = Math.min(active, signers.length - 1); markDirty(); drawSigners(); drawPalette(); drawFields(); drawProps();
          } }, svg(icons.x, 14)) : null),
        nameIn, emailIn);
    }), signers.length < 20 ? h("button", { class: "btn ghost block", onclick: () => {
      signers.push({ name: "", email: "", color: COLORS[signers.length % COLORS.length]! }); active = signers.length - 1; markDirty(); drawSigners(); drawPalette();
      (signerList.querySelectorAll(".signer")[active]?.querySelector("input") as HTMLInputElement | null)?.focus();
    } }, svg(icons.plus, 16), "Add signer") : null);
  };
  const drawPalette = () => {
    const s = signers[active]!;
    set(palette, 
      h("div", { class: "palette-for" }, "Fields for ", h("b", { style: { color: s.color } }, s.name || `Signer ${active + 1}`)),
      ...Object.entries(FIELD_META).map(([type, m]) => h("button", {
        class: `tool${placing === type ? " on" : ""}`, draggable: "true", "data-type": type, style: { "--c": s.color },
        onclick: () => { placing = placing === type ? null : type; drawPalette(); pagesWrap.classList.toggle("placing", !!placing); },
        ondragstart: (e: DragEvent) => { e.dataTransfer?.setData("text/inkpact-field", type); },
      }, svg(m.icon, 17), m.label)),
      h("p", { class: "fine" }, placing ? `Click on the page to place the ${FIELD_META[placing]!.label.toLowerCase()} field.` : "Click a field, then click the page. Or drag it onto the page."));
  };

  // Right: properties of the selected field.
  const props = h("div", { class: "props" });
  const drawProps = () => {
    const f = fields.find((x) => x.key === selected);
    if (!f) {
      set(props, h("div", { class: "props-empty" }, h("h3", null, "Field properties"), h("p", { class: "muted" }, "Select a field on the page to change who fills it in, whether it's required, or its label."),
        h("div", { class: "summary" }, signers.map((s, i) => h("div", { class: "sum-row" }, h("span", { class: "dot", style: { background: s.color } }), h("span", null, s.name || `Signer ${i + 1}`), h("b", null, String(fields.filter((x) => x.signer === i).length)))))));
      return;
    }
    const who = h("select", { class: "input", "aria-label": "Signer" }, signers.map((s, i) => h("option", { value: i, selected: i === f.signer }, s.name || `Signer ${i + 1}`)));
    who.addEventListener("change", () => { f.signer = Number(who.value); markDirty(); drawFields(); drawSigners(); });
    const req = h("input", { type: "checkbox", checked: f.required, disabled: f.type === "signature" || f.type === "date" });
    req.addEventListener("change", () => { f.required = req.checked; markDirty(); drawFields(); });
    const label = h("input", { class: "input", value: f.label, placeholder: FIELD_META[f.type]!.label, maxlength: 80 });
    label.addEventListener("input", () => { f.label = label.value; markDirty(); drawFields(); });
    set(props, 
      h("h3", null, svg(FIELD_META[f.type]!.icon, 17), FIELD_META[f.type]!.label),
      h("label", { class: "fld" }, h("span", null, "Filled in by"), who),
      f.type !== "signature" && f.type !== "date" ? h("label", { class: "check" }, req, h("span", null, "Required")) : null,
      f.type === "text" || f.type === "checkbox" ? h("label", { class: "fld" }, h("span", null, "Label (shown to the signer)"), label) : null,
      h("p", { class: "fine" }, `Page ${f.page + 1}`),
      h("button", { class: "btn danger-ghost block", onclick: () => { fields.splice(fields.indexOf(f), 1); selected = null; markDirty(); drawFields(); drawProps(); drawSigners(); } }, svg(icons.trash, 16), "Remove field"));
  };

  // Center: the pages with fields on them.
  const pagesWrap = h("div", { class: "pages editing" });
  let boxes: PageBox[] = [];
  const place = (type: string, page: number, cx: number, cy: number) => {
    const pg = env.pages[page]!;
    const m = FIELD_META[type]!;
    const w = m.w / pg.w, hh = m.h / pg.h;
    const f: EdField = { key: `f${k++}`, signer: active, type, page, x: Math.min(Math.max(0, cx - w / 2), 1 - w), y: Math.min(Math.max(0, cy - hh / 2), 1 - hh), w, h: hh, required: type !== "checkbox", label: "" };
    fields.push(f); selected = f.key; placing = null; pagesWrap.classList.remove("placing");
    markDirty(); drawFields(); drawProps(); drawPalette(); drawSigners();
  };

  const drawFields = () => {
    for (const b of boxes) b.layer.replaceChildren();
    for (const f of fields) {
      const b = boxes[f.page];
      const s = signers[f.signer];
      if (!b || !s) continue;
      const m = FIELD_META[f.type]!;
      const el = h("div", {
        class: `field t-${f.type}${selected === f.key ? " sel" : ""}`, tabindex: 0, role: "button", "aria-label": `${m.label} for ${s.name || `Signer ${f.signer + 1}`}`,
        style: { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, "--c": s.color },
      }, f.type === "checkbox" ? null : h("span", { class: "f-label" }, svg(m.icon, 13), f.label || m.label, f.required ? "" : h("em", null, " (optional)")),
        h("span", { class: "f-who" }, initialsOf(s.name || `S ${f.signer + 1}`)),
        selected === f.key ? h("span", { class: "handle", "data-handle": "1" }) : null);
      el.addEventListener("pointerdown", (e) => startDrag(e, f, el, b));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") { fields.splice(fields.indexOf(f), 1); selected = null; markDirty(); drawFields(); drawProps(); drawSigners(); }
      });
      b.layer.append(el);
    }
  };

  function startDrag(e: PointerEvent, f: EdField, el: HTMLElement, b: PageBox) {
    e.stopPropagation(); e.preventDefault();
    if (selected !== f.key) { selected = f.key; drawFields(); drawProps(); const again = b.layer.querySelectorAll(".field")[[...fields].filter((x) => x.page === f.page).indexOf(f)] as HTMLElement; el = again ?? el; }
    const resize = (e.target as HTMLElement).dataset.handle === "1";
    const rect = b.layer.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const o = { x: f.x, y: f.y, w: f.w, h: f.h };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 2) moved = true;
      if (resize) {
        if (f.type === "checkbox") { const d = Math.max(dx * rect.width, dy * rect.height); const sz = Math.max(10, o.w * rect.width + d); f.w = Math.min(sz / rect.width, 1 - f.x); f.h = Math.min(sz / rect.height, 1 - f.y); }
        else { f.w = Math.min(Math.max(0.03, o.w + dx), 1 - f.x); f.h = Math.min(Math.max(0.012, o.h + dy), 1 - f.y); }
      } else {
        f.x = Math.min(Math.max(0, o.x + dx), 1 - f.w); f.y = Math.min(Math.max(0, o.y + dy), 1 - f.h);
      }
      const cur = b.layer.querySelector(".field.sel") as HTMLElement | null;
      if (cur) Object.assign(cur.style, { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (moved) markDirty(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const titleIn = h("input", { class: "title-input", value: title, maxlength: 160, "aria-label": "Envelope title" });
  titleIn.addEventListener("input", () => { title = titleIn.value; markDirty(); });

  const sendBtn = h("button", { class: "btn primary", onclick: () => void reviewAndSend() }, svg(icons.send, 16), "Review and send");
  async function reviewAndSend() {
    for (const [i, s] of signers.entries()) {
      if (!s.name.trim()) { toast(`Add a name for signer ${i + 1}`, "err"); active = i; drawSigners(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) { toast(`Add a valid email for ${s.name}`, "err"); active = i; drawSigners(); return; }
      if (!fields.some((f) => f.signer === i && f.type === "signature")) { toast(`Place a signature field for ${s.name}`, "err"); active = i; drawSigners(); drawPalette(); return; }
    }
    const msg = h("textarea", { class: "input", rows: 4, maxlength: 2000, placeholder: "Optional message to your signers" }, message);
    const m = modal({
      title: "Review and send", wide: true,
      body: h("div", { class: "review" },
        h("div", { class: "review-doc" }, h("span", { class: "doc-ico" }, svg(icons.doc, 20)), h("div", null, h("b", null, title), h("small", { class: "muted" }, `${env.pages.length} page${env.pages.length === 1 ? "" : "s"} · ${fields.length} field${fields.length === 1 ? "" : "s"}`))),
        h("h4", null, "Signers"),
        h("ul", { class: "review-list" }, signers.map((s, i) => h("li", null, h("span", { class: "avatar sm", style: { background: s.color } }, initialsOf(s.name)), h("div", null, h("b", null, s.name), h("small", { class: "muted" }, s.email)), h("small", { class: "muted right" }, `${fields.filter((f) => f.signer === i).length} fields`)))),
        h("label", { class: "fld" }, h("span", null, "Message"), msg),
        h("p", { class: "fine" }, "Each signer gets a private link by email. You'll also see every link on the next page, so you can share it yourself.")),
      actions: [h("button", { class: "btn ghost", onclick: () => m.close() }, "Back to editing"), h("button", { class: "btn primary", onclick: async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true; btn.textContent = "Sending…";
        message = msg.value; dirty = true;
        try {
          await save();
          await api(`/api/envelopes/${id}/send`, { method: "POST" });
          m.close();
          go(`/e/${id}?sent=1`);
        } catch (err) { toast((err as Error).message, "err"); btn.disabled = false; btn.textContent = "Send"; }
      } }, svg(icons.send, 16), "Send")],
    });
  }

  root.className = "editor-root";
  set(root, h("div", { class: "editor" },
    h("header", { class: "ed-top" },
      h("a", { class: "icon-btn", href: "/", "data-nav": "", "aria-label": "Back to envelopes", onclick: () => void save() }, svg(icons.back)),
      h("div", { class: "ed-title" }, titleIn, h("small", { class: "muted" }, env.file_name, " · ", status)),
      h("div", { class: "ed-actions" },
        h("button", { class: "btn ghost", onclick: async () => { dirty = true; await save(); toast("Draft saved"); } }, svg(icons.save, 16), "Save draft"),
        h("button", { class: "btn ghost", onclick: async () => {
          if (!fields.length) { toast("Place some fields first", "err"); return; }
          dirty = true; await save();
          const name = await promptDialog("Save as template", "Template name", title, "Save template"); if (!name) return;
          try { await api("/api/templates", { method: "POST", json: { envelope_id: id, name } }); toast("Saved as a template"); } catch (err) { toast((err as Error).message, "err"); }
        } }, svg(icons.template, 16), "Save as template"),
        sendBtn)),
    h("aside", { class: "ed-left" }, h("h3", null, "Signers"), signerList, h("h3", null, "Fields"), palette),
    h("section", { class: "ed-center" }, pagesWrap),
    h("aside", { class: "ed-right" }, props)));

  drawSigners(); drawPalette(); drawProps();
  boxes = await renderPdf(`/api/envelopes/${id}/pdf`, pagesWrap);
  for (const b of boxes) {
    b.layer.addEventListener("pointerdown", (e) => {
      if (e.target !== b.layer) return;
      const r = b.layer.getBoundingClientRect();
      if (placing) { place(placing, b.index, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); return; }
      if (selected) { selected = null; drawFields(); drawProps(); }
    });
    b.layer.addEventListener("dragover", (e) => e.preventDefault());
    b.layer.addEventListener("drop", (e) => {
      e.preventDefault();
      const type = e.dataTransfer?.getData("text/inkpact-field");
      if (!type || !FIELD_META[type]) return;
      const r = b.layer.getBoundingClientRect();
      place(type, b.index, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
  }
  drawFields();
  const beforeUnload = (e: BeforeUnloadEvent) => { if (dirty) { void save(); e.preventDefault(); } };
  window.addEventListener("beforeunload", beforeUnload);
  cleanup = () => { window.removeEventListener("beforeunload", beforeUnload); if (dirty) void save(); };
}

// ---------- envelope status ----------
const STEPS = ["sent", "viewed", "signed"];
function signerProgress(s: Signer) {
  const reached = s.status === "signed" ? 3 : s.status === "viewed" ? 2 : s.status === "sent" ? 1 : 0;
  return h("ol", { class: "steps" }, STEPS.map((st, i) => h("li", { class: i < reached ? "done" : "" }, h("i"), h("span", null, st === "sent" ? "Sent" : st === "viewed" ? "Viewed" : "Signed"),
    h("small", null, fmtDateTime(st === "sent" ? s.sent_at : st === "viewed" ? s.viewed_at : s.signed_at)))));
}

async function detail(id: string) {
  set(root, frame("envelopes", h("div", { class: "loading" }, h("div", { class: "spinner" }))));
  let d = await api<Detail>(`/api/envelopes/${id}`);
  if (d.envelope.status === "draft") { go(`/e/${id}/edit`, true); return; }
  const justSent = new URLSearchParams(location.search).get("sent") === "1";
  if (justSent) history.replaceState(null, "", `/e/${id}`);

  const head = h("div");
  const signersCard = h("div", { class: "card" });
  const eventsCard = h("div", { class: "card" });
  const preview = h("div", { class: "pages preview" });
  let previewFor = "";

  const drawHead = () => {
    const e = d.envelope;
    const signed = d.signers.filter((s) => s.status === "signed").length;
    const canManage = me.role !== "member" || e.created_by_email === me.email;
    set(head, h("div", { class: "detail-head" },
      h("a", { class: "back", href: "/", "data-nav": "" }, svg(icons.back, 16), "Envelopes"),
      h("div", { class: "dh-row" },
        h("div", null, h("h1", null, e.title), h("p", { class: "muted" }, `Sent ${fmtDateTime(e.sent_at)} by ${e.created_by_name || e.created_by_email}`, e.completed_at ? ` · Completed ${fmtDateTime(e.completed_at)}` : "")),
        h("div", { class: "dh-actions" },
          e.status === "completed" ? h("a", { class: "btn primary", href: `/api/envelopes/${id}/signed.pdf`, download: "" }, svg(icons.download, 16), "Download signed PDF") : null,
          e.status === "sent" ? h("button", { class: "btn ghost", onclick: async () => { try { const r = await api<{ reminded: number }>(`/api/envelopes/${id}/remind`, { method: "POST" }); toast(`Reminder sent to ${r.reminded} signer${r.reminded === 1 ? "" : "s"}`); await refresh(); } catch (err) { toast((err as Error).message, "err"); } } }, svg(icons.bell, 16), "Remind") : null,
          h("button", { class: "btn ghost", onclick: async () => { const name = await promptDialog("Save as template", "Template name", e.title, "Save template"); if (!name) return; try { await api("/api/templates", { method: "POST", json: { envelope_id: id, name } }); toast("Saved as a template"); } catch (err) { toast((err as Error).message, "err"); } } }, svg(icons.template, 16), "Save as template"),
          e.status === "sent" && canManage ? h("button", { class: "btn danger-ghost", onclick: async () => { if (!(await confirmDialog("Void this envelope?", "Signers won't be able to open or sign it any more. This can't be undone.", "Void envelope", true))) return; try { await api(`/api/envelopes/${id}/void`, { method: "POST", json: {} }); toast("Envelope voided"); await refresh(); } catch (err) { toast((err as Error).message, "err"); } } }, svg(icons.ban, 16), "Void") : null,
          e.status !== "sent" && canManage ? h("button", { class: "icon-btn", "aria-label": "Delete envelope", title: "Delete", onclick: async () => { if (!(await confirmDialog("Delete this envelope?", "The document, signatures and audit trail will be deleted for good.", "Delete", true))) return; try { await api(`/api/envelopes/${id}`, { method: "DELETE" }); toast("Deleted"); go("/"); } catch (err) { toast((err as Error).message, "err"); } } }, svg(icons.trash)) : null)),
      h("div", { class: "banner s-" + e.status },
        pill(e.status),
        h("span", null, e.status === "completed" ? "Everyone has signed. The signed PDF includes a certificate of completion with the full audit trail."
          : e.status === "sent" ? `${signed} of ${d.signers.length} signed. This page updates by itself.`
          : e.status === "declined" ? `${d.signers.find((s) => s.status === "declined")?.name ?? "A signer"} declined to sign.${d.signers.find((s) => s.status === "declined")?.declined_reason ? ` Reason: "${d.signers.find((s) => s.status === "declined")!.declined_reason}"` : ""}`
          : "This envelope was voided. Its links no longer work."),
        h("div", { class: "meter" }, h("i", { style: { width: `${(signed / Math.max(1, d.signers.length)) * 100}%` } })))));
  };

  const drawSignersCard = () => {
    set(signersCard, h("h2", null, "Signers"), h("ul", { class: "signer-rows" }, d.signers.map((s) => h("li", null,
      h("div", { class: "sr-who" }, h("span", { class: "avatar", style: { background: s.color } }, initialsOf(s.name)), h("div", null, h("b", null, s.name), h("small", { class: "muted" }, s.email)), signerPill(s.status)),
      signerProgress(s),
      s.link && d.envelope.status === "sent" && s.status !== "signed" ? h("div", { class: "linkbox" },
        svg(icons.link, 15), h("input", { class: "link-in", readonly: true, value: s.link, "aria-label": `Signing link for ${s.name}`, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
        h("button", { class: "btn sm ghost", onclick: () => copyText(s.link!) }, svg(icons.copy, 14), "Copy"),
        h("a", { class: "btn sm ghost", href: s.link, target: "_blank", rel: "noopener", "data-testid": `open-link-${s.position}` }, svg(icons.external, 14), "Open")) : null,
      s.status === "signed" ? h("div", { class: "sr-meta" }, h("span", null, svg(icons.shield, 14), `IP ${s.ip ?? "unknown"}`), h("span", { title: s.user_agent ?? "" }, (s.user_agent ?? "").slice(0, 80))) : null))));
  };

  const drawEvents = () => {
    const icon: Record<string, string> = { created: icons.doc, sent: icons.send, emailed: icons.send, viewed: icons.eye, signed: icons.pen, completed: icons.check, declined: icons.ban, voided: icons.ban, reminded: icons.bell };
    set(eventsCard, h("h2", null, "Audit trail"), h("ol", { class: "timeline" }, [...d.events].reverse().map((ev) => h("li", { class: `ev-${ev.action}` },
      h("span", { class: "tl-ico" }, svg(icon[ev.action] ?? icons.clock, 14)),
      h("div", null, h("b", null, `${ev.actor} `, h("span", { class: "muted" }, ev.action)), ev.detail ? h("p", null, ev.detail) : null,
        h("small", { class: "muted" }, fmtDateTime(ev.at), ev.ip ? ` · IP ${ev.ip}` : ""))))));
  };

  const drawPreview = async () => {
    const want = d.envelope.status === "completed" ? "signed" : "original";
    if (previewFor === want) return;
    previewFor = want;
    preview.replaceChildren();
    const boxes = await renderPdf(want === "signed" ? `/api/envelopes/${id}/signed.pdf` : `/api/envelopes/${id}/pdf`, preview);
    if (want === "original") for (const f of d.fields) {
      const s = d.signers.find((x) => x.id === f.signer_id); const b = boxes[f.page];
      if (!s || !b) continue;
      b.layer.append(h("div", { class: `field ro t-${f.type}`, style: { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, "--c": s.color } },
        f.type === "checkbox" ? null : h("span", { class: "f-label" }, svg(FIELD_META[f.type]!.icon, 12), f.value && f.type !== "signature" && f.type !== "initials" ? f.value : FIELD_META[f.type]!.label)));
    }
  };

  async function refresh() {
    d = await api<Detail>(`/api/envelopes/${id}`);
    drawHead(); drawSignersCard(); drawEvents(); void drawPreview();
  }

  drawHead(); drawSignersCard(); drawEvents();
  set(root, frame("envelopes", head, h("div", { class: "detail-grid" }, h("div", { class: "col" }, signersCard, eventsCard), h("div", { class: "card doc-card" }, h("h2", null, d.envelope.status === "completed" ? "Signed document" : "Document"), preview))));
  void drawPreview();

  if (justSent) {
    modal({
      title: "Sent for signature",
      body: h("div", { class: "sent-box" },
        h("div", { class: "sent-ico" }, svg(icons.send, 26)),
        h("p", null, "Each signer was emailed their own link. You can also copy a link and send it yourself:"),
        h("ul", { class: "review-list" }, d.signers.map((s) => h("li", null, h("span", { class: "avatar sm", style: { background: s.color } }, initialsOf(s.name)), h("div", null, h("b", null, s.name), h("small", { class: "muted" }, s.email)),
          h("button", { class: "btn sm ghost", onclick: () => copyText(s.link!) }, svg(icons.copy, 14), "Copy link"))))),
      actions: [h("button", { class: "btn primary", onclick: (e: Event) => (e.currentTarget as HTMLElement).closest(".backdrop")?.remove() }, "Done")],
    });
  }

  // Poll while signers are working so the status changes on its own.
  const poll = window.setInterval(() => { if (d.envelope.status === "sent" && !document.hidden) void refresh().catch(() => {}); }, 3000);
  const onFocus = () => void refresh().catch(() => {});
  window.addEventListener("focus", onFocus);
  cleanup = () => { clearInterval(poll); window.removeEventListener("focus", onFocus); };
}

// ---------- templates ----------
async function templates() {
  set(root, frame("templates", h("div", { class: "loading" }, h("div", { class: "spinner" }))));
  const { templates: list } = await api<{ templates: { id: string; name: string; file_name: string; pages: unknown[]; roles: { name: string; color: string }[]; field_count: number; created_by_name: string; created_at: number }[] }>("/api/templates");
  set(root, frame("templates",
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Templates"), h("p", { class: "muted" }, "Reuse a document with its fields already placed. Save any envelope as a template from its editor or status page."))),
    list.length ? h("div", { class: "tpl-grid" }, list.map((t) => h("div", { class: "card tpl" },
      h("div", { class: "tpl-art" }, svg(icons.doc, 30)),
      h("h3", null, t.name),
      h("p", { class: "muted" }, `${t.pages.length} page${t.pages.length === 1 ? "" : "s"} · ${t.field_count} fields · ${t.roles.length} signer${t.roles.length === 1 ? "" : "s"}`),
      h("div", { class: "avatars" }, t.roles.map((r) => h("span", { class: "avatar sm", style: { background: r.color } }, initialsOf(r.name)))),
      h("small", { class: "muted" }, `Saved ${fmtDate(t.created_at)}${t.created_by_name ? ` by ${t.created_by_name}` : ""}`),
      h("div", { class: "tpl-actions" },
        h("button", { class: "btn primary", onclick: async () => { try { const { id } = await api<{ id: string }>(`/api/templates/${t.id}/use`, { method: "POST" }); go(`/e/${id}/edit`); } catch (err) { toast((err as Error).message, "err"); } } }, svg(icons.arrow, 16), "Use template"),
        me.role !== "member" ? h("button", { class: "icon-btn", "aria-label": `Delete template ${t.name}`, onclick: async () => { if (!(await confirmDialog("Delete this template?", "Envelopes already made from it aren't affected.", "Delete", true))) return; await api(`/api/templates/${t.id}`, { method: "DELETE" }); toast("Template deleted"); void templates(); } }, svg(icons.trash)) : null)))) :
      h("div", { class: "empty" }, h("div", { class: "empty-art" }, svg(icons.template, 34)), h("h2", null, "No templates yet"), h("p", null, "Open a draft, place your fields, then choose Save as template."))));
}

void route();
