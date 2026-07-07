import "./style.css";
import { Engine, type Acks } from "./engine";
import { Renderer } from "./render";

const engine = new Engine();
const renderer = new Renderer(engine);

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const hud = document.getElementById("hud")!;
const controlsEl = document.getElementById("controls")!;
const chaptersEl = document.getElementById("chapters")!;
const platformLink = document.getElementById("platform-link") as HTMLAnchorElement;
platformLink.href = "https://github.com/rafeeban4/order-platform";

// --- responsive canvas ------------------------------------------------------
function sizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", sizeCanvas);

// --- event log --------------------------------------------------------------
const log: { text: string; kind: string; t: number }[] = [];
engine.onEvent = (text, kind) => {
  log.unshift({ text, kind, t: performance.now() });
  if (log.length > 5) log.pop();
};

// --- controls ---------------------------------------------------------------
type Btn = { label: string; on: () => void; kind?: string };
function makeGroup(title: string, buttons: Btn[]): HTMLElement {
  const g = document.createElement("div");
  g.className = "cgroup";
  const h = document.createElement("span");
  h.className = "cgroup-title";
  h.textContent = title;
  g.appendChild(h);
  const row = document.createElement("div");
  row.className = "cgroup-row";
  for (const b of buttons) {
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.kind) el.dataset.kind = b.kind;
    el.onclick = b.on;
    row.appendChild(el);
  }
  g.appendChild(row);
  return g;
}

let rateLabel: HTMLSpanElement;
let acksButtons: HTMLButtonElement[] = [];

function buildControls() {
  controlsEl.innerHTML = "";

  controlsEl.appendChild(
    makeGroup("Flow", [
      { label: "⏸ Pause", on: () => (engine.paused = !engine.paused) },
      { label: "↺ Reset", on: () => { engine.reset(); syncAcks(); } },
    ]),
  );

  const rateGroup = makeGroup("Throughput", [
    { label: "–", on: () => setRate(engine.globalRate - 0.5) },
    { label: "+", on: () => setRate(engine.globalRate + 0.5) },
  ]);
  rateLabel = document.createElement("span");
  rateLabel.className = "rate-label";
  rateGroup.appendChild(rateLabel);
  controlsEl.appendChild(rateGroup);

  controlsEl.appendChild(
    makeGroup("Producers", [
      { label: "+ producer", on: () => engine.addProducer() },
      { label: "– producer", on: () => engine.removeProducer() },
    ]),
  );

  controlsEl.appendChild(
    makeGroup("Consumer group", [
      { label: "+ consumer", on: () => engine.addConsumer() },
      { label: "– consumer", on: () => engine.removeConsumer() },
    ]),
  );

  const acksGroup = document.createElement("div");
  acksGroup.className = "cgroup";
  const at = document.createElement("span");
  at.className = "cgroup-title";
  at.textContent = "acks (durability)";
  acksGroup.appendChild(at);
  const arow = document.createElement("div");
  arow.className = "cgroup-row";
  acksButtons = (["0", "1", "all"] as Acks[]).map((a) => {
    const b = document.createElement("button");
    b.textContent = "acks=" + a;
    b.onclick = () => { engine.acks = a; syncAcks(); };
    arow.appendChild(b);
    return b;
  });
  acksGroup.appendChild(arow);
  controlsEl.appendChild(acksGroup);

  controlsEl.appendChild(
    makeGroup("Partitions", [
      { label: "3", on: () => engine.setPartitions(3) },
      { label: "4", on: () => engine.setPartitions(4) },
      { label: "6", on: () => engine.setPartitions(6) },
    ]),
  );

  controlsEl.appendChild(
    makeGroup("Chaos", [
      { label: "💥 kill broker", on: () => engine.killBroker(), kind: "bad" },
      { label: "✓ restore", on: () => engine.restoreBroker() },
    ]),
  );

  syncAcks();
}

function setRate(r: number) {
  engine.globalRate = Math.max(0, Math.min(6, Math.round(r * 2) / 2));
}
function syncAcks() {
  acksButtons.forEach((b) => {
    b.dataset.active = String(b.textContent === "acks=" + engine.acks);
  });
}

// --- chapters (guided tour) -------------------------------------------------
interface Chapter {
  title: string;
  body: string;
  apply: () => void;
}
const chapters: Chapter[] = [
  {
    title: "1 · The append-only log",
    body: "A producer sends events; the broker <b>appends</b> each to a partition — an ordered, immutable log. Nothing is ever edited, only added. Watch a message travel from producer → log → consumer.",
    apply: () => { engine.reset(4); engine.globalRate = 0.6; },
  },
  {
    title: "2 · Partitioning by key",
    body: "Each event has a <b>key</b> (colour). The key is hashed to pick a partition, so <b>every event for the same key lands in the same partition</b> — and is therefore delivered in order. Different keys spread across partitions for parallelism.",
    apply: () => { engine.reset(4); engine.globalRate = 1.5; },
  },
  {
    title: "3 · Consumer groups & rebalancing",
    body: "Consumers form a <b>group</b>. The broker assigns each partition to exactly <b>one</b> consumer in the group. Add or remove consumers and watch a <b>rebalance</b> reassign the lanes — that's how streaming scales horizontally.",
    apply: () => { engine.reset(6); engine.globalRate = 2; engine.addConsumer(); engine.addConsumer(); },
  },
  {
    title: "4 · Lag: the number that matters",
    body: "If producers outrun consumers, un-read messages pile up in the log — that gap is <b>consumer lag</b>. Crank throughput or drop a consumer and watch lag climb. In production this is your #1 health metric.",
    apply: () => { engine.reset(4); engine.globalRate = 4; },
  },
  {
    title: "5 · acks: the durability dial",
    body: "<b>acks=0</b>: fire-and-forget, fastest, loses data on failure. <b>acks=1</b>: wait for the leader — no retry here, so an outage still drops. <b>acks=all</b>: a durable producer (replicas + retries) — records park in a <b>retry buffer</b> (pulsing rings) instead of dropping. Hit <b>kill broker</b> under each setting: watch <b>dropped</b> climb at acks=0/1, but at acks=all only <b>buffered</b> grows — then drains to zero when you restore.",
    apply: () => { engine.reset(4); engine.globalRate = 2.5; engine.acks = "0"; syncAcks(); },
  },
  {
    title: "6 · A broker dies mid-stream",
    body: "Kill the broker while traffic flows. In-flight writes fail; with weak acks they're <b>dropped</b> (red ✕). Restore it and the stream heals. This is exactly the failure the companion order-platform hardens against with awaited acks + idempotency keys.",
    apply: () => { engine.reset(4); engine.globalRate = 3; engine.acks = "1"; syncAcks(); },
  },
];

let chapterIdx = 0;
let bodyEl: HTMLElement;
let counterEl: HTMLElement;

function buildChapters() {
  chaptersEl.innerHTML = "";
  const card = document.createElement("div");
  card.className = "chapter-card";

  const nav = document.createElement("div");
  nav.className = "chapter-nav";
  const prev = document.createElement("button");
  prev.textContent = "‹ Prev";
  prev.onclick = () => gotoChapter(chapterIdx - 1);
  counterEl = document.createElement("span");
  counterEl.className = "chapter-counter";
  const next = document.createElement("button");
  next.textContent = "Next ›";
  next.onclick = () => gotoChapter(chapterIdx + 1);
  nav.append(prev, counterEl, next);

  bodyEl = document.createElement("div");
  bodyEl.className = "chapter-body";

  card.append(nav, bodyEl);
  chaptersEl.appendChild(card);
  renderChapter();
}

function gotoChapter(i: number) {
  chapterIdx = (i + chapters.length) % chapters.length;
  // Silence the event log while a chapter reconfigures the scene, then start it
  // fresh — otherwise setup fires a burst of near-identical rebalance lines.
  const saved = engine.onEvent;
  engine.onEvent = () => {};
  chapters[chapterIdx].apply();
  engine.onEvent = saved;
  log.length = 0;
  syncAcks();
  renderChapter();
}
function renderChapter() {
  const c = chapters[chapterIdx];
  counterEl.textContent = `${chapterIdx + 1} / ${chapters.length}`;
  bodyEl.innerHTML = `<h3>${c.title}</h3><p>${c.body}</p>`;
}

// --- HUD --------------------------------------------------------------------
function renderHud() {
  const m = engine.metrics;
  const lag = engine.lag;
  const lagKind = lag > 40 ? "bad" : lag > 15 ? "warn" : "ok";
  const stat = (label: string, val: string | number, kind = "") =>
    `<div class="stat" data-kind="${kind}"><span>${label}</span><b>${val}</b></div>`;

  const logHtml = log
    .map((l) => `<div class="ev" data-kind="${l.kind}">${l.text}</div>`)
    .join("");

  hud.innerHTML = `
    <div class="stats">
      ${stat("throughput", m.throughput + "/s")}
      ${stat("committed", m.committed)}
      ${stat("consumed", m.consumed)}
      ${stat("lag", lag, lagKind)}
      ${stat("dropped", m.dropped, m.dropped > 0 ? "bad" : "")}
      ${engine.buffered > 0 ? stat("buffered", engine.buffered, "warn") : ""}
      ${stat("acks", "acks=" + engine.acks)}
    </div>
    <div class="evlog">${logHtml}</div>
  `;
}

// --- main loop --------------------------------------------------------------
let last = performance.now();
let hudTick = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  engine.update(dt);
  const rect = canvas.getBoundingClientRect();
  renderer.draw(ctx, rect.width, rect.height);

  if (rateLabel) rateLabel.textContent = `${engine.globalRate.toFixed(1)}×`;
  hudTick += dt;
  if (hudTick > 0.1) { renderHud(); hudTick = 0; }
  requestAnimationFrame(frame);
}

buildControls();
buildChapters();
sizeCanvas();
gotoChapter(0);
requestAnimationFrame(frame);
