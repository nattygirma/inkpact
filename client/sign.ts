// The signing page an outside signer opens from their link. No account needed.
import { h, set, svg, icons, api, toast, modal, fmtDateTime, initialsOf, FIELD_META, bootData, pill, signerPill } from "./ui";
import { adoptSignature } from "./sigpad";
import { renderPdf, type PageBox } from "./pdf";

type Field = { id: string; signer_id: string; type: string; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value: string | null };
type Data = {
  envelope: { title: string; message: string; status: string; pages: { w: number; h: number }[]; file_name: string; sender: string; sender_email: string; completed_at: number | null };
  me: { id: string; name: string; email: string; color: string; status: string; signed_at: number | null; signature: string | null; initials: string | null };
  others: { id: string; name: string; color: string; status: string }[];
  fields: Field[];
  signatures: Record<string, { signature: string | null; initials: string | null }>;
};

const { token } = bootData<{ token: string }>();
const base = `/s/${token}`;
const root = document.getElementById("root")!;

const today = () => new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

async function main() {
  const d = await api<Data>(`${base}/data`);
  const e = d.envelope;
  if (d.me.status === "signed" || e.status !== "sent" || d.me.status === "declined") return finished(d);

  const mine = d.fields.filter((f) => f.signer_id === d.me.id);
  const theirs = d.fields.filter((f) => f.signer_id !== d.me.id);
  const values: Record<string, string | boolean> = {};
  for (const f of mine) {
    if (f.type === "name") values[f.id] = d.me.name;
    if (f.type === "checkbox") values[f.id] = false;
  }
  let adopted: { signature: string; initials: string } | null = null;
  const stamped = new Set<string>(); // signature/initials fields the signer has clicked
  let consent = false;

  const needSig = mine.some((f) => f.type === "signature");
  const needIni = mine.some((f) => f.type === "initials");

  const isDone = (f: Field) => {
    if (f.type === "signature" || f.type === "initials") return stamped.has(f.id);
    if (f.type === "date") return true;
    if (f.type === "checkbox") return values[f.id] === true || !f.required;
    const v = String(values[f.id] ?? "").trim();
    return !!v || !f.required;
  };
  const required = mine.filter((f) => f.required || f.type === "signature" || f.type === "initials");
  const progressEl = h("div", { class: "sg-progress" });
  const finishBtn = h("button", { class: "btn primary", onclick: () => void finish() }, svg(icons.check, 16), "Finish");
  const nextBtn = h("button", { class: "btn ghost", onclick: () => jumpNext() }, "Next field", svg(icons.arrow, 16));
  const updateProgress = () => {
    const done = required.filter(isDone).length;
    set(progressEl, h("b", null, `${done} of ${required.length}`), " required fields done", h("div", { class: "meter" }, h("i", { style: { width: `${(done / Math.max(1, required.length)) * 100}%` } })));
    const all = done === required.length;
    finishBtn.classList.toggle("pulse", all);
    nextBtn.hidden = all;
  };

  const pagesWrap = h("div", { class: "pages signing" });
  let boxes: PageBox[] = [];
  const els = new Map<string, HTMLElement>();

  const jumpNext = () => {
    const next = mine.find((f) => !isDone(f) && (f.required || f.type === "signature" || f.type === "initials"));
    const el = next && els.get(next.id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200);
    (el.querySelector("input") as HTMLInputElement | null)?.focus({ preventScroll: true });
  };

  async function stamp(f: Field) {
    if (!consent) { await askConsent(); if (!consent) return; }
    if (!adopted) {
      const r = await adoptSignature({ name: d.me.name, needSignature: needSig, needInitials: needIni });
      if (!r) return;
      adopted = { signature: r.signature, initials: r.initials };
      for (const x of mine) if (x.type === "name" && values[x.id] === d.me.name) values[x.id] = r.name;
    }
    if (stamped.has(f.id)) stamped.delete(f.id); else stamped.add(f.id);
    drawFields(); updateProgress();
    if (stamped.has(f.id)) setTimeout(jumpNext, 250);
  }

  const drawFields = () => {
    for (const b of boxes) b.layer.replaceChildren();
    els.clear();
    // Other signers' finished fields, read-only.
    for (const f of theirs) {
      const b = boxes[f.page]; if (!b) continue;
      const img = f.type === "signature" ? d.signatures[f.signer_id]?.signature : f.type === "initials" ? d.signatures[f.signer_id]?.initials : null;
      b.layer.append(h("div", { class: `sfield done other t-${f.type}`, style: pos(f) },
        img ? h("img", { src: img, alt: "Signature" }) : f.type === "checkbox" ? (f.value === "true" ? svg(icons.check, 14) : null) : h("span", { class: "val" }, f.value ?? "")));
    }
    for (const f of mine) {
      const b = boxes[f.page]; if (!b) continue;
      const m = FIELD_META[f.type]!;
      const done = isDone(f);
      let el: HTMLElement;
      if (f.type === "signature" || f.type === "initials") {
        const img = stamped.has(f.id) && adopted ? (f.type === "signature" ? adopted.signature : adopted.initials) : null;
        el = h("button", { class: `sfield t-${f.type}${img ? " done" : " todo"}`, style: { ...pos(f), "--c": d.me.color }, "aria-label": img ? `${m.label} added` : `Click to add your ${m.label.toLowerCase()}`, onclick: () => void stamp(f) },
          img ? h("img", { src: img, alt: m.label }) : h("span", { class: "cta" }, svg(m.icon, 14), f.type === "signature" ? "Sign" : "Initial"));
      } else if (f.type === "date") {
        el = h("div", { class: "sfield t-date done", style: pos(f), title: "Filled in when you finish" }, h("span", { class: "val" }, today()));
      } else if (f.type === "checkbox") {
        const box = h("input", { type: "checkbox", checked: values[f.id] === true, "aria-label": f.label || "Checkbox" });
        box.addEventListener("change", () => { values[f.id] = box.checked; updateProgress(); el.classList.toggle("todo", !isDone(f)); });
        el = h("label", { class: `sfield t-checkbox${done ? "" : " todo"}`, style: { ...pos(f), "--c": d.me.color }, title: f.label || "" }, box);
      } else {
        const input = h("input", { class: "f-input", value: String(values[f.id] ?? ""), placeholder: f.label || m.label, maxlength: f.type === "name" ? 120 : 500, "aria-label": f.label || m.label });
        input.addEventListener("input", () => { values[f.id] = input.value; el.classList.toggle("todo", !isDone(f)); updateProgress(); });
        el = h("div", { class: `sfield t-${f.type}${done ? "" : " todo"}`, style: { ...pos(f), "--c": d.me.color } }, input);
      }
      if (!f.required && f.type !== "signature" && f.type !== "initials") el.classList.add("optional");
      els.set(f.id, el);
      b.layer.append(el);
    }
  };

  async function askConsent(): Promise<void> {
    return new Promise((resolve) => {
      const box = h("input", { type: "checkbox", id: "consent" });
      const m = modal({
        title: "Review and sign electronically",
        body: h("div", null,
          h("p", null, h("b", null, e.sender), " has sent you ", h("b", null, `"${e.title}"`), " to sign."),
          e.message ? h("blockquote", { class: "msg" }, e.message) : null,
          h("label", { class: "check consent" }, box, h("span", null, "I agree to use electronic records and signatures, and I'm ", h("b", null, d.me.name), " (", d.me.email, ").")),
          h("p", { class: "fine" }, "Your IP address, browser and the time you sign are recorded in the document's audit trail.")),
        actions: [h("button", { class: "btn primary", onclick: () => { if (!box.checked) { toast("Tick the box to continue", "err"); return; } consent = true; m.close(); } }, "Continue")],
        onClose: () => resolve(),
      });
    });
  }

  async function finish() {
    if (!consent) { await askConsent(); if (!consent) return; }
    const missing = required.find((f) => !isDone(f));
    if (missing) { toast(`Fill in all required fields first (page ${missing.page + 1})`, "err"); jumpNext(); return; }
    finishBtn.disabled = true; finishBtn.textContent = "Finishing…";
    try {
      const r = await api<{ ok: boolean; completed: boolean }>(`${base}/sign`, { method: "POST", json: {
        consent: true, signature: adopted?.signature, initials: adopted?.initials,
        values, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      } });
      toast(r.completed ? "Signed. Everyone has signed!" : "Signed");
      void main();
    } catch (err) {
      toast((err as Error).message, "err");
      finishBtn.disabled = false; set(finishBtn, svg(icons.check, 16), "Finish");
    }
  }

  const decline = async () => {
    const reason = h("textarea", { class: "input", rows: 3, maxlength: 500, placeholder: "Tell the sender why (optional)" });
    const m = modal({
      title: "Decline to sign?",
      body: h("div", null, h("p", { class: "muted" }, `The sender will be told, and nobody will be able to sign "${e.title}" any more.`), reason),
      actions: [h("button", { class: "btn ghost", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn danger", onclick: async () => {
        try { await api(`${base}/decline`, { method: "POST", json: { reason: reason.value } }); m.close(); void main(); } catch (err) { toast((err as Error).message, "err"); }
      } }, "Decline")],
    });
  };

  root.className = "sign-root";
  set(root, 
    h("header", { class: "sg-top" },
      h("div", { class: "sg-brand" }, h("img", { src: "/assets/icon.svg", alt: "", width: 26, height: 26 }), h("div", null, h("b", null, e.title), h("small", { class: "muted" }, `From ${e.sender}`))),
      progressEl,
      h("div", { class: "sg-actions" }, h("button", { class: "link-btn", onclick: () => void decline() }, "Decline"), nextBtn, finishBtn)),
    h("div", { class: "sg-body" },
      h("aside", { class: "sg-side" },
        h("div", { class: "card" },
          h("h3", null, "Signing as"),
          h("div", { class: "sr-who" }, h("span", { class: "avatar", style: { background: d.me.color } }, initialsOf(d.me.name)), h("div", null, h("b", null, d.me.name), h("small", { class: "muted" }, d.me.email))),
          d.others.length ? h("h3", null, "Other signers") : null,
          d.others.map((o) => h("div", { class: "sum-row" }, h("span", { class: "dot", style: { background: o.color } }), h("span", null, o.name), signerPill(o.status))),
          h("h3", null, "Your fields"),
          Object.entries(FIELD_META).filter(([t]) => mine.some((f) => f.type === t)).map(([t, m]) => h("div", { class: "sum-row" }, svg(m.icon, 15), h("span", null, m.label), h("b", null, String(mine.filter((f) => f.type === t).length)))),
          h("a", { class: "btn ghost block sm", href: `${base}/pdf`, target: "_blank", rel: "noopener" }, svg(icons.download, 14), "Download original"))),
      h("main", { class: "sg-main" }, e.message ? h("div", { class: "card msg-card" }, h("small", { class: "muted" }, `Message from ${e.sender}`), h("p", null, e.message)) : null, pagesWrap)));
  updateProgress();
  boxes = await renderPdf(`${base}/pdf`, pagesWrap);
  drawFields();
  await askConsent();
  if (consent) setTimeout(jumpNext, 300);
}

const pos = (f: Field) => ({ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });

function finished(d: Data) {
  const e = d.envelope;
  const msg = d.me.status === "declined" ? ["You declined to sign", "The sender has been told."]
    : e.status === "voided" ? ["This document was withdrawn", "The sender voided it, so it can't be signed any more."]
    : e.status === "declined" ? ["Signing was stopped", "Another signer declined, so this document can't be completed."]
    : e.status === "completed" ? ["Everyone has signed", `"${e.title}" is complete. Download your copy with its certificate of completion.`]
    : ["You're done", `Thanks, ${d.me.name}. We'll email you the finished document when everyone has signed.`];
  root.className = "sign-root";
  set(root, h("main", { class: "land done-page" },
    h("div", { class: "brand big" }, h("img", { src: "/assets/icon.svg", alt: "", width: 40, height: 40 }), h("span", null, "Inkpact")),
    h("div", { class: `done-ico ${e.status === "completed" || d.me.status === "signed" ? "ok" : "bad"}` }, svg(e.status === "completed" || d.me.status === "signed" ? icons.check : icons.ban, 34)),
    h("h1", null, msg[0]!), h("p", null, msg[1]!),
    e.status === "completed" ? h("a", { class: "btn primary lg", href: `${base}/signed.pdf`, download: "" }, svg(icons.download, 18), "Download signed PDF") : null,
    h("div", { class: "card done-card" },
      h("div", { class: "sum-row" }, h("span", { class: "dot", style: { background: d.me.color } }), h("span", null, `${d.me.name} (you)`), signerPill(d.me.status)),
      d.others.map((o) => h("div", { class: "sum-row" }, h("span", { class: "dot", style: { background: o.color } }), h("span", null, o.name), signerPill(o.status))),
      d.me.signed_at ? h("p", { class: "fine" }, `You signed ${fmtDateTime(d.me.signed_at)}.`) : null),
    h("p", { class: "fine" }, `Document: ${e.title} · sent by ${e.sender}`)));
}

main().catch((err) => {
  root.className = "sign-root";
  set(root, h("main", { class: "land" }, h("h1", null, "This link doesn't work"), h("p", null, (err as Error).message)));
});
