// Builds the finished PDF: every signer's fields drawn onto the original pages,
// then a certificate of completion with the audit trail.
import type { PDFFont, PDFPage, PDFImage } from "pdf-lib";

export type StampEnvelope = {
  id: string; title: string; file_name: string; original_sha256: string;
  created_by_name: string; created_by_email: string;
  created_at: number; sent_at: number | null; completed_at: number | null;
};
export type StampSigner = {
  id: string; name: string; email: string; status: string;
  viewed_at: number | null; signed_at: number | null; ip: string | null; user_agent: string | null;
  signature: string | null; initials: string | null;
};
export type StampField = {
  signer_id: string; type: string; page: number; x: number; y: number; w: number; h: number; value: string | null;
};
export type StampEvent = { at: number; actor: string; action: string; detail: string; ip: string | null };

// Helvetica (WinAnsi) can't draw every character; replace what it can't.
export const winAnsi = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "-");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of winAnsi(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      let w = word;
      // Break very long tokens (user agents, hashes).
      while (font.widthOfTextAtSize(w, size) > width) {
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        if (line) { lines.push(line); line = ""; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = w; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export async function buildSignedPdf(
  original: ArrayBuffer, env: StampEnvelope, signers: StampSigner[], fields: StampField[], events: StampEvent[],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(original);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const ink = rgb(0.06, 0.1, 0.2);

  const images = new Map<string, PDFImage>();
  const image = async (url: string | null) => {
    if (!url) return null;
    if (!images.has(url)) images.set(url, await doc.embedPng(dataUrlBytes(url)));
    return images.get(url)!;
  };
  const byId = new Map(signers.map((s) => [s.id, s]));

  for (const f of fields) {
    const page = pages[f.page];
    const signer = byId.get(f.signer_id);
    if (!page || !signer) continue;
    const box = page.getCropBox();
    const fx = box.x + f.x * box.width;
    const fw = f.w * box.width;
    const fh = f.h * box.height;
    const fy = box.y + box.height - f.y * box.height - fh; // PDF origin is bottom-left

    if (f.type === "signature" || f.type === "initials") {
      const img = await image(f.type === "signature" ? signer.signature : signer.initials);
      if (!img) continue;
      const scale = Math.min(fw / img.width, fh / img.height);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: fx + (fw - w) / 2, y: fy + (fh - h) / 2, width: w, height: h });
    } else if (f.type === "checkbox") {
      if (f.value === "true") {
        const s = Math.min(fw, fh);
        page.drawText("X", { x: fx + (fw - bold.widthOfTextAtSize("X", s * 0.85)) / 2, y: fy + (fh - s * 0.62) / 2, size: s * 0.85, font: bold, color: ink });
      }
    } else if (f.value) {
      const text = winAnsi(f.value);
      let size = Math.min(12, fh * 0.62);
      while (size > 5 && helv.widthOfTextAtSize(text, size) > fw - 2) size -= 0.5;
      page.drawText(text, { x: fx + 1, y: fy + (fh - size * 0.72) / 2, size, font: helv, color: ink });
    }
  }

  await addCertificate(doc, helv, bold, env, signers, events, image);
  doc.setTitle(env.title);
  doc.setProducer("Inkpact");
  doc.setModificationDate(new Date(env.completed_at ?? Date.now()));
  return doc.save();
}

async function addCertificate(
  doc: import("pdf-lib").PDFDocument, helv: PDFFont, bold: PDFFont,
  env: StampEnvelope, signers: StampSigner[], events: StampEvent[],
  image: (url: string | null) => Promise<PDFImage | null>,
) {
  const { rgb } = await import("pdf-lib");
  const W = 612, H = 792, M = 54, CW = W - M * 2;
  const ink = rgb(0.06, 0.1, 0.2), muted = rgb(0.36, 0.41, 0.5), line = rgb(0.86, 0.88, 0.91), teal = rgb(0.05, 0.49, 0.4);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M) newPage(); };
  const text = (t: string, x: number, size = 9, font = helv, color = ink) => page.drawText(winAnsi(t), { x, y, size, font, color });
  const rule = () => { page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: line }); };

  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: teal });
  text("INKPACT", M, 9, bold, teal); y -= 26;
  text("Certificate of completion", M, 20, bold); y -= 22;
  text(env.title, M, 11, helv, muted); y -= 24;

  const kv = (k: string, v: string) => {
    const lines = wrap(v, helv, 9, CW - 130);
    need(lines.length * 12 + 2);
    text(k, M, 9, bold, muted);
    for (const l of lines) { text(l, M + 130, 9); y -= 12; }
  };
  kv("Envelope ID", env.id);
  kv("Document", env.file_name);
  kv("Original SHA-256", env.original_sha256);
  kv("Sent by", `${env.created_by_name || "-"} <${env.created_by_email || "-"}>`);
  kv("Created", fmt(env.created_at));
  kv("Sent", fmt(env.sent_at));
  kv("Completed", fmt(env.completed_at));
  kv("Signers", String(signers.length));
  y -= 10; rule(); y -= 22;

  need(30);
  text("Signers", M, 13, bold); y -= 20;
  for (const s of signers) {
    const ua = wrap(s.user_agent || "-", helv, 8, CW - 230);
    need(78 + ua.length * 10);
    const top = y;
    text(s.name, M, 11, bold); y -= 14;
    text(s.email, M, 9, helv, muted); y -= 16;
    const row = (k: string, v: string) => { text(k, M, 8, bold, muted); text(v, M + 70, 8); y -= 11; };
    row("Status", s.status);
    row("Viewed", fmt(s.viewed_at));
    row("Signed", fmt(s.signed_at));
    row("IP address", s.ip || "-");
    text("User agent", M, 8, bold, muted);
    for (const l of ua) { text(l, M + 70, 8); y -= 10; }
    const img = await image(s.signature);
    if (img) {
      const bw = 170, bh = 56, scale = Math.min(bw / img.width, bh / img.height);
      page.drawRectangle({ x: W - M - bw - 8, y: top - bh - 6, width: bw + 8, height: bh + 10, borderColor: line, borderWidth: 0.8 });
      page.drawImage(img, { x: W - M - bw - 4 + (bw - img.width * scale) / 2, y: top - bh - 1, width: img.width * scale, height: img.height * scale });
      page.drawText("Signature", { x: W - M - bw - 8, y: top - bh - 16, size: 7, font: helv, color: muted });
    }
    y = Math.min(y, top - 84) - 8; rule(); y -= 18;
  }

  need(40);
  text("Audit trail", M, 13, bold); y -= 18;
  text("Time (UTC)", M, 8, bold, muted); text("Event", M + 120, 8, bold, muted); text("By", M + 230, 8, bold, muted); text("IP", M + 420, 8, bold, muted);
  y -= 6; rule(); y -= 12;
  for (const e of events) {
    const detail = wrap(e.detail ? `${e.actor}: ${e.detail}` : e.actor, helv, 8, 180);
    need(detail.length * 10 + 4);
    text(fmt(e.at).replace(" UTC", ""), M, 8);
    text(e.action, M + 120, 8, bold);
    text(e.ip || "", M + 420, 8, helv, muted);
    for (const l of detail) { text(l, M + 230, 8); y -= 10; }
    y -= 3;
  }
  y -= 10; need(30);
  for (const l of wrap("Each signer agreed to do business electronically and adopted the signature shown. This certificate was generated by Inkpact when the last signer finished.", helv, 7.5, CW)) {
    text(l, M, 7.5, helv, muted); y -= 10;
  }
}
