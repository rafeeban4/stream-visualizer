import type { Engine, Message } from "./engine";

// Pure drawing layer. Given engine state, paint a frame. All layout is derived
// from the current canvas size so it stays responsive.

interface Pt {
  x: number;
  y: number;
}

const COL = {
  bg: "#0b0f1a",
  panel: "#121826",
  lane: "#1b2436",
  laneEdge: "#2a3550",
  text: "#e6ecff",
  dim: "#8592b5",
  ok: "#4ec9a5",
  warn: "#e0b64b",
  bad: "#e2685f",
  wire: "#2f3d5c",
};

export class Renderer {
  constructor(private engine: Engine) {}

  private producerPt(i: number, n: number, w: number, h: number): Pt {
    void w;
    const top = 90;
    const usable = h - top - 40;
    const y = top + (usable * (i + 1)) / (n + 1);
    return { x: 70, y };
  }

  private consumerPt(i: number, n: number, w: number, h: number): Pt {
    const top = 90;
    const usable = h - top - 40;
    const y = top + (usable * (i + 1)) / (n + 1);
    return { x: w - 70, y };
  }

  private laneY(p: number, count: number, h: number): number {
    const top = 90;
    const usable = h - top - 40;
    return top + (usable * (p + 0.5)) / count;
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const e = this.engine;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, w, h);

    const brokerLeft = Math.round(w * 0.34);
    const brokerRight = Math.round(w * 0.66);
    const laneCount = e.partitions.length;

    // --- Broker body -------------------------------------------------------
    const brokerDown = e.brokerDown;
    ctx.fillStyle = COL.panel;
    roundRect(ctx, brokerLeft - 10, 70, brokerRight - brokerLeft + 20, h - 70 - 30, 12);
    ctx.fill();
    ctx.strokeStyle = brokerDown ? COL.bad : COL.laneEdge;
    ctx.lineWidth = brokerDown ? 2 : 1;
    ctx.stroke();

    ctx.fillStyle = brokerDown ? COL.bad : COL.dim;
    ctx.font = "600 12px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(
      brokerDown ? "BROKER — DOWN" : `BROKER · topic "orders" · ${laneCount} partitions`,
      (brokerLeft + brokerRight) / 2,
      86,
    );

    // --- Partition lanes ---------------------------------------------------
    for (let p = 0; p < laneCount; p++) {
      const y = this.laneY(p, laneCount, h);
      ctx.strokeStyle = COL.lane;
      ctx.lineWidth = 18;
      ctx.beginPath();
      ctx.moveTo(brokerLeft + 6, y);
      ctx.lineTo(brokerRight - 6, y);
      ctx.stroke();

      ctx.fillStyle = COL.dim;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`P${p}`, brokerLeft + 10, y - 14);

      // owner wire: lane exit -> owning consumer
      const owner = e.consumerForPartition(p);
      if (owner) {
        const ci = e.consumers.indexOf(owner);
        const cp = this.consumerPt(ci, e.consumers.length, w, h);
        ctx.strokeStyle = e.rebalancing > 0 ? withAlpha(COL.warn, 0.5) : COL.wire;
        ctx.lineWidth = 1;
        ctx.setLineDash(e.rebalancing > 0 ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(brokerRight - 6, y);
        ctx.lineTo(cp.x - 22, cp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- Producers ---------------------------------------------------------
    e.producers.forEach((p, i) => {
      const pt = this.producerPt(i, e.producers.length, w, h);
      node(ctx, pt, 22, COL.panel, COL.ok, `P${p.id}`);
    });
    // Column labels sit at the bottom so they never collide with the HUD overlay.
    ctx.fillStyle = COL.dim;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("PRODUCERS", 70, h - 12);

    // --- Consumers ---------------------------------------------------------
    e.consumers.forEach((c, i) => {
      const pt = this.consumerPt(i, e.consumers.length, w, h);
      const highlight = e.rebalancing > 0 ? COL.warn : COL.ok;
      node(ctx, pt, 22, COL.panel, highlight, `C${c.id}`);
      ctx.fillStyle = COL.dim;
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(`[${c.partitions.map((x) => "P" + x).join(" ") || "idle"}]`, pt.x, pt.y + 36);
    });
    ctx.fillStyle = COL.dim;
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(e.consumers.length ? "CONSUMER GROUP" : "NO CONSUMERS", w - 70, h - 12);

    // --- Messages ----------------------------------------------------------
    // Pre-compute per-partition slots: inLog messages queue rightward inside the
    // lane; buffered (retry) messages stack leftward outside the lane entry.
    const queueSlot = new Map<number, number>();
    const bufferSlot = new Map<number, number>();
    for (let p = 0; p < laneCount; p++) {
      e.messages
        .filter((m) => m.partition === p && m.phase === "inLog")
        .sort((a, b) => a.offset - b.offset)
        .forEach((m, idx) => queueSlot.set(m.id, idx));
      e.messages
        .filter((m) => m.partition === p && m.phase === "buffered")
        .sort((a, b) => a.id - b.id)
        .forEach((m, idx) => bufferSlot.set(m.id, idx));
    }

    for (const m of e.messages) {
      const pos = this.messagePos(m, w, h, brokerLeft, brokerRight, laneCount, queueSlot, bufferSlot);
      this.drawMessage(ctx, m, pos);
    }
  }

  private messagePos(
    m: Message,
    w: number,
    h: number,
    brokerLeft: number,
    brokerRight: number,
    laneCount: number,
    queueSlot: Map<number, number>,
    bufferSlot: Map<number, number>,
  ): Pt & { alpha: number; r: number } {
    const e = this.engine;
    const y = this.laneY(m.partition, laneCount, h);
    const ease = (t: number) => t * t * (3 - 2 * t);

    switch (m.phase) {
      case "toBroker": {
        const pi = e.producers.findIndex((p) => p.id === m.producerId);
        const from = this.producerPt(pi < 0 ? 0 : pi, e.producers.length, w, h);
        const to = { x: brokerLeft + 4, y };
        return { ...lerpPt(from, to, ease(m.progress)), alpha: 1, r: 6 };
      }
      case "committing": {
        // pulse at the lane entry; acks=all shows a wider replication ring
        return { x: brokerLeft + 14, y, alpha: 1, r: 6 };
      }
      case "buffered": {
        // stacked just outside the lane entry — the producer's retry buffer
        const slot = bufferSlot.get(m.id) ?? 0;
        const x = Math.max(brokerLeft - 58, brokerLeft - 10 - slot * 12);
        return { x, y, alpha: 1, r: 6 };
      }
      case "inLog": {
        const slot = queueSlot.get(m.id) ?? 0;
        const x = brokerLeft + 24 + slot * 15;
        return { x: Math.min(x, brokerRight - 10), y, alpha: 1, r: 6 };
      }
      case "toConsumer": {
        const ci = e.consumers.findIndex((c) => c.id === m.consumerId);
        const from = { x: brokerRight - 4, y };
        const to = this.consumerPt(ci < 0 ? 0 : ci, e.consumers.length, w, h);
        return { ...lerpPt(from, to, ease(m.progress)), alpha: 1, r: 6 };
      }
      case "done": {
        const ci = e.consumers.findIndex((c) => c.id === m.consumerId);
        const at = this.consumerPt(ci < 0 ? 0 : ci, e.consumers.length, w, h);
        return { x: at.x, y: at.y, alpha: 1 - m.progress / 0.7, r: 6 + m.progress * 6 };
      }
      case "dropped": {
        return { x: brokerLeft + 14, y: y + m.progress * 40, alpha: 1 - m.progress / 0.7, r: 6 };
      }
    }
  }

  private drawMessage(ctx: CanvasRenderingContext2D, m: Message, pos: Pt & { alpha: number; r: number }) {
    ctx.globalAlpha = Math.max(0, pos.alpha);
    const color = m.phase === "dropped" ? COL.bad : `hsl(${m.keyHue} 70% 60%)`;

    if (m.phase === "committing") {
      // replication ring: acks=all draws a slower, wider ring to show it waits
      // for followers; acks=1 a tight one; acks=0 basically none.
      const acks = this.engine.acks;
      const ringR = acks === "all" ? 8 + m.progress * 10 : acks === "1" ? 8 + m.progress * 5 : 8;
      ctx.strokeStyle = withAlpha(acks === "all" ? COL.warn : COL.ok, 1 - m.progress * 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (m.phase === "buffered") {
      // "still retrying" pulse — a breathing warn ring around the held record.
      const pulse = 7 + Math.sin(m.progress * 6) * 3;
      ctx.strokeStyle = withAlpha(COL.warn, 0.8);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, pos.r, 0, Math.PI * 2);
    ctx.fill();

    if (m.phase === "dropped") {
      ctx.strokeStyle = COL.bad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pos.x - 4, pos.y - 4);
      ctx.lineTo(pos.x + 4, pos.y + 4);
      ctx.moveTo(pos.x + 4, pos.y - 4);
      ctx.lineTo(pos.x - 4, pos.y + 4);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// --- small canvas helpers ---------------------------------------------------

function node(ctx: CanvasRenderingContext2D, pt: Pt, r: number, fill: string, stroke: string, label: string) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = stroke;
  ctx.font = "600 12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pt.x, pt.y);
  ctx.textBaseline = "alphabetic";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
