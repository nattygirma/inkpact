// Tiny DOM helpers shared by the sender app and the signing page.
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === "html") el.innerHTML = String(v);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children.flat(10 as 1)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const svg = (inner: string, size = 18) => {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return s;
};

export const icons = {
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  initials: '<path d="M4 18V6l5 8 5-8v12"/><path d="M18 6v12"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkbox: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  template: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
};

export async function api<T = unknown>(url: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const init: RequestInit = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

let toastWrap: HTMLElement | null = null;
export function toast(msg: string, kind: "ok" | "err" | "info" = "ok") {
  if (!toastWrap) { toastWrap = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(toastWrap); }
  const t = h("div", { class: `toast ${kind}` }, svg(kind === "err" ? icons.x : icons.check, 16), msg);
  toastWrap.append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, kind === "err" ? 5000 : 2600);
}

export function modal(opts: { title: string; body: Node; actions?: Node[]; wide?: boolean; onClose?: () => void }) {
  const close = () => { back.remove(); document.removeEventListener("keydown", esc); opts.onClose?.(); };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const box = h("div", { class: `modal${opts.wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": opts.title },
    h("div", { class: "modal-head" }, h("h2", null, opts.title), h("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, svg(icons.x))),
    h("div", { class: "modal-body" }, opts.body),
    opts.actions ? h("div", { class: "modal-foot" }, opts.actions) : null,
  );
  const back = h("div", { class: "backdrop", onmousedown: (e: MouseEvent) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener("keydown", esc);
  requestAnimationFrame(() => (box.querySelector("input,textarea,button.primary") as HTMLElement | null)?.focus());
  return { close, box };
}

export function confirmDialog(title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: h("p", { class: "muted" }, text),
      actions: [
        h("button", { class: "btn ghost", onclick: () => { done = true; m.close(); resolve(false); } }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => { done = true; m.close(); resolve(true); } }, okLabel),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function promptDialog(title: string, label: string, value: string, okLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { class: "input", value, maxlength: 120, "aria-label": label });
    const ok = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } done = true; m.close(); resolve(v); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
    const m = modal({
      title, body: h("label", { class: "fld" }, h("span", null, label), input),
      actions: [h("button", { class: "btn ghost", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, okLabel)],
      onClose: () => { if (!done) resolve(null); },
    });
    requestAnimationFrame(() => input.select());
  });
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); toast("Link copied"); }
  catch { prompt("Copy this link", text); }
}

export const fmtDate = (ms?: number | null) => ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
export const fmtDateTime = (ms?: number | null) => ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
export function timeAgo(ms?: number | null) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return fmtDate(ms);
}
export const initialsOf = (name: string) => name.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((p) => p[0]!.toUpperCase()).join("") || "?";

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", sent: "Waiting for others", completed: "Completed", declined: "Declined", voided: "Voided",
  pending: "Not sent", viewed: "Viewed", signed: "Signed",
};
const SIGNER_LABEL: Record<string, string> = { pending: "Not sent", sent: "Sent", viewed: "Viewed", signed: "Signed", declined: "Declined" };
export const signerPill = (status: string) => h("span", { class: `pill s-${status}` }, h("i"), SIGNER_LABEL[status] ?? status);
export const pill = (status: string, label?: string) => h("span", { class: `pill s-${status}` }, h("i"), label ?? STATUS_LABEL[status] ?? status);

export const FIELD_META: Record<string, { label: string; icon: string; w: number; h: number }> = {
  signature: { label: "Signature", icon: icons.pen, w: 170, h: 46 },
  initials: { label: "Initials", icon: icons.initials, w: 62, h: 38 },
  date: { label: "Date signed", icon: icons.calendar, w: 110, h: 22 },
  name: { label: "Full name", icon: icons.user, w: 160, h: 22 },
  text: { label: "Text", icon: icons.text, w: 170, h: 22 },
  checkbox: { label: "Checkbox", icon: icons.checkbox, w: 16, h: 16 },
};

export function brand(org?: string) {
  return h("a", { class: "brand", href: "/" }, h("img", { src: "/assets/icon.svg", alt: "", width: 28, height: 28 }), h("span", null, "Inkpact"), org ? h("em", null, org) : null);
}

export function bootData<T>(): T {
  return JSON.parse(document.getElementById("boot-data")?.textContent || "{}") as T;
}

/** replaceChildren that skips null/false children (replaceChildren would print "null"). */
export function set(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}
