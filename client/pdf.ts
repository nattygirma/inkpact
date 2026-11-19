// Renders PDF pages with pdf.js. Each page becomes a .page box (sized in CSS)
// with a canvas and an empty .layer on top for fields.
import * as pdfjs from "pdfjs-dist";
import { h } from "./ui";

pdfjs.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.min.mjs";

export type PageBox = { el: HTMLDivElement; layer: HTMLDivElement; index: number; w: number; h: number };

export async function renderPdf(url: string, container: HTMLElement, opts: { width?: number } = {}): Promise<PageBox[]> {
  const doc = await pdfjs.getDocument({ url }).promise;
  const boxes: PageBox[] = [];
  const pages: pdfjs.PDFPageProxy[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(page);
    const vp = page.getViewport({ scale: 1 });
    const layer = h("div", { class: "layer" });
    const el = h("div", { class: "page", "data-page": i - 1, style: { aspectRatio: `${vp.width} / ${vp.height}` } },
      h("canvas", null), layer, h("div", { class: "page-no" }, `${i} / ${doc.numPages}`));
    container.append(el);
    boxes.push({ el, layer, index: i - 1, w: vp.width, h: vp.height });
  }

  // Draw visible pages first, then the rest, at the size they're shown.
  const draw = async (i: number) => {
    const box = boxes[i]!;
    if (box.el.dataset.drawn) return;
    box.el.dataset.drawn = "1";
    const page = pages[i]!;
    const cssW = opts.width ?? (box.el.clientWidth || 800);
    const scale = (cssW / box.w) * Math.min(2.5, window.devicePixelRatio || 1) * 1.25;
    const vp = page.getViewport({ scale });
    const canvas = box.el.querySelector("canvas")!;
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    box.el.classList.add("ready");
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) void draw(Number((e.target as HTMLElement).dataset.page));
  }, { rootMargin: "800px 0px" });
  boxes.forEach((b) => io.observe(b.el));
  return boxes;
}
