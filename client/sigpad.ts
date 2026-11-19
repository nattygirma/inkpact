// "Adopt your signature" dialog: draw it or type it. Returns trimmed PNG data URLs.
import { h, set, modal, svg, icons, initialsOf, toast } from "./ui";

const INK = "#14213d";
const SCRIPT = '"Dancing Script", "Segoe Script", "Brush Script MT", cursive';

class Pad {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pts: { x: number; y: number }[] = [];
  empty = true;
  onchange = () => {};

  constructor(public label: string, aspect: number) {
    this.canvas = h("canvas", { class: "pad", "aria-label": label, style: { aspectRatio: String(aspect) } });
    this.ctx = this.canvas.getContext("2d")!;
    const pos = (e: PointerEvent) => { const r = this.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (this.canvas.width / r.width), y: (e.clientY - r.top) * (this.canvas.height / r.height) }; };
    this.canvas.addEventListener("pointerdown", (e) => {
      this.fit();
      this.canvas.setPointerCapture(e.pointerId);
      this.pts = [pos(e)];
      this.ctx.beginPath();
      const p = this.pts[0]!;
      this.ctx.arc(p.x, p.y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
      this.ctx.fillStyle = INK; this.ctx.fill();
      this.mark();
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.pts.length) return;
      const p = pos(e);
      this.pts.push(p);
      const n = this.pts.length;
      if (n < 3) return;
      const a = this.pts[n - 3]!, b = this.pts[n - 2]!;
      this.ctx.beginPath();
      this.ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.ctx.quadraticCurveTo(b.x, b.y, (b.x + p.x) / 2, (b.y + p.y) / 2);
      this.ctx.stroke();
    });
    const end = () => { this.pts = []; };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }
  private sized = false;
  fit() {
    if (this.sized) return;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.lineCap = "round"; this.ctx.lineJoin = "round";
    this.ctx.strokeStyle = INK; this.ctx.lineWidth = 2.4 * dpr;
    this.sized = true;
  }
  private mark() { if (this.empty) { this.empty = false; this.onchange(); } }
  clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.empty = true; this.onchange(); }
  png() { return trim(this.canvas); }
}

// Crop to the ink so the signature fills its field.
function trim(src: HTMLCanvasElement): string {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3]! > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return "";
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  // Keep it small: at most 900px wide.
  const scale = Math.min(1, 900 / (x1 - x0 + 1));
  const out = document.createElement("canvas");
  out.width = Math.round((x1 - x0 + 1) * scale); out.height = Math.round((y1 - y0 + 1) * scale);
  out.getContext("2d")!.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

async function typed(text: string, px: number): Promise<string> {
  await document.fonts.load(`${px}px "Dancing Script"`).catch(() => {});
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `${px}px ${SCRIPT}`;
  const w = Math.ceil(ctx.measureText(text).width) + px;
  c.width = w; c.height = Math.ceil(px * 1.6);
  ctx.font = `${px}px ${SCRIPT}`;
  ctx.fillStyle = INK; ctx.textBaseline = "middle";
  ctx.fillText(text, px / 2, c.height / 2);
  return trim(c);
}

export function adoptSignature(opts: { name: string; needInitials: boolean; needSignature: boolean }): Promise<{ signature: string; initials: string; name: string } | null> {
  return new Promise((resolve) => {
    let mode: "type" | "draw" = "type";
    let done = false;
    const nameIn = h("input", { class: "input", value: opts.name, maxlength: 120, "aria-label": "Full name" });
    const iniIn = h("input", { class: "input", value: initialsOf(opts.name), maxlength: 6, "aria-label": "Initials" });
    const preview = h("div", { class: "typed-preview" });
    const sigPad = new Pad("Draw your signature", 3.2);
    const iniPad = new Pad("Draw your initials", 1.6);

    const renderPreview = () => {
      set(preview, 
        opts.needSignature ? h("div", { class: "typed-sig" }, h("small", null, "Signature"), h("span", null, nameIn.value || " ")) : null,
        opts.needInitials ? h("div", { class: "typed-ini" }, h("small", null, "Initials"), h("span", null, iniIn.value || " ")) : null,
      );
    };
    nameIn.addEventListener("input", () => { iniIn.value = initialsOf(nameIn.value); renderPreview(); });
    iniIn.addEventListener("input", renderPreview);
    renderPreview();

    const typePane = h("div", { class: "pane" },
      h("div", { class: "row2" },
        h("label", { class: "fld" }, h("span", null, "Full name"), nameIn),
        opts.needInitials ? h("label", { class: "fld small" }, h("span", null, "Initials"), iniIn) : null),
      preview);
    const drawPane = h("div", { class: "pane", hidden: true },
      opts.needSignature ? h("div", { class: "pad-wrap" }, h("div", { class: "pad-head" }, h("span", null, "Draw your signature"), h("button", { class: "link-btn", onclick: () => sigPad.clear() }, "Clear")), sigPad.canvas, h("div", { class: "pad-line" })) : null,
      opts.needInitials ? h("div", { class: "pad-wrap ini" }, h("div", { class: "pad-head" }, h("span", null, "Initials"), h("button", { class: "link-btn", onclick: () => iniPad.clear() }, "Clear")), iniPad.canvas, h("div", { class: "pad-line" })) : null);

    const tabType = h("button", { class: "tab on", role: "tab", onclick: () => setMode("type") }, svg(icons.text, 16), "Type");
    const tabDraw = h("button", { class: "tab", role: "tab", onclick: () => setMode("draw") }, svg(icons.pen, 16), "Draw");
    const setMode = (m: "type" | "draw") => {
      mode = m;
      tabType.classList.toggle("on", m === "type"); tabDraw.classList.toggle("on", m === "draw");
      typePane.hidden = m !== "type"; drawPane.hidden = m !== "draw";
      if (m === "draw") requestAnimationFrame(() => { sigPad.fit(); iniPad.fit(); });
    };

    const adopt = h("button", { class: "btn primary", onclick: async () => {
      const name = nameIn.value.trim();
      if (!name) { toast("Type your full name", "err"); nameIn.focus(); return; }
      let signature = "", initials = "";
      if (mode === "type") {
        if (opts.needSignature) signature = await typed(name, 96);
        if (opts.needInitials) initials = await typed(iniIn.value.trim() || initialsOf(name), 96);
      } else {
        if (opts.needSignature && sigPad.empty) { toast("Draw your signature first", "err"); return; }
        if (opts.needInitials && iniPad.empty) { toast("Draw your initials too", "err"); return; }
        if (opts.needSignature) signature = sigPad.png();
        if (opts.needInitials) initials = iniPad.png();
      }
      done = true; m.close(); resolve({ signature, initials, name });
    } }, svg(icons.check, 16), "Adopt and sign");

    const m = modal({
      title: "Adopt your signature",
      wide: true,
      body: h("div", { class: "adopt" },
        h("p", { class: "muted" }, "Your signature will be placed in every signature field assigned to you."),
        h("div", { class: "tabs", role: "tablist" }, tabType, tabDraw),
        typePane, drawPane,
        h("p", { class: "fine" }, "By selecting Adopt and sign, I agree that this signature is the electronic representation of my signature for all purposes when I use it on documents, just like a pen-and-paper signature.")),
      actions: [h("button", { class: "btn ghost", onclick: () => m.close() }, "Cancel"), adopt],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}
