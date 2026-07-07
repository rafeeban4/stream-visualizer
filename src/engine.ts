// StreamScope simulation engine.
// A deliberately simplified but behaviourally-honest model of an event-streaming
// system: producers -> broker (partitioned log) -> consumer group. The point is
// to make the *tradeoffs* visible (ordering, partitioning, acks, lag, failure),
// not to reimplement Kafka.

export type Acks = "0" | "1" | "all";

export type MsgPhase = "toBroker" | "committing" | "inLog" | "toConsumer" | "done" | "dropped";

export interface Message {
  id: number;
  key: string;
  keyHue: number;
  partition: number;
  offset: number; // assigned when committed to the log
  phase: MsgPhase;
  progress: number; // 0..1 within the current phase's animation
  bornAt: number;
  producerId: number;
  consumerId: number; // resolved when it starts flowing to a consumer
}

export interface Producer {
  id: number;
  rate: number; // messages per second (per producer, scaled by global rate)
  accumulator: number;
}

export interface Consumer {
  id: number;
  partitions: number[]; // assigned partition indices (rebalanced)
  processed: number;
}

export interface Partition {
  index: number;
  log: number[]; // message ids in commit order
  committedOffset: number; // next offset to assign
}

export interface Metrics {
  produced: number;
  committed: number;
  consumed: number;
  dropped: number;
  throughput: number; // committed msgs/sec, smoothed
}

const KEYS = ["alice", "bob", "cart-9", "order-42", "usr-7", "sess-x", "sku-3", "geo-eu"];

function hashKey(key: string, partitions: number): number {
  // Small stable string hash -> partition. Same key always same partition,
  // which is exactly why per-key ordering is preserved.
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % partitions;
}

function hueForKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

export class Engine {
  producers: Producer[] = [];
  consumers: Consumer[] = [];
  partitions: Partition[] = [];
  messages: Message[] = [];

  acks: Acks = "1";
  idempotent = false;
  brokerDown = false;
  globalRate = 1; // multiplier on producer rate
  paused = false;

  metrics: Metrics = { produced: 0, committed: 0, consumed: 0, dropped: 0, throughput: 0 };

  private nextMsgId = 1;
  private partitionCount = 4;
  private throughputWindow: number[] = [];
  private lastRebalance = 0;
  rebalancing = 0; // seconds remaining on rebalance highlight

  onEvent: (text: string, kind: "info" | "warn" | "bad") => void = () => {};

  constructor() {
    this.reset();
  }

  reset(partitions = 4) {
    this.partitionCount = partitions;
    this.partitions = Array.from({ length: partitions }, (_, i) => ({
      index: i,
      log: [],
      committedOffset: 0,
    }));
    this.producers = [{ id: 1, rate: 2.5, accumulator: 0 }];
    this.consumers = [];
    this.messages = [];
    this.metrics = { produced: 0, committed: 0, consumed: 0, dropped: 0, throughput: 0 };
    this.nextMsgId = 1;
    this.acks = "1";
    this.idempotent = false;
    this.brokerDown = false;
    this.globalRate = 1;
    this.addConsumer(); // start with one consumer so something flows
  }

  get lag(): number {
    // Total un-consumed committed messages across partitions.
    const inLog = this.messages.filter((m) => m.phase === "inLog").length;
    return inLog;
  }

  addProducer() {
    const id = (this.producers.at(-1)?.id ?? 0) + 1;
    this.producers.push({ id, rate: 2.5, accumulator: 0 });
    this.onEvent(`Producer P${id} joined`, "info");
  }

  removeProducer() {
    if (this.producers.length <= 1) return;
    const p = this.producers.pop()!;
    this.onEvent(`Producer P${p.id} left`, "info");
  }

  addConsumer() {
    const id = (this.consumers.at(-1)?.id ?? 0) + 1;
    this.consumers.push({ id, partitions: [], processed: 0 });
    this.rebalance(`Consumer C${id} joined the group`);
  }

  removeConsumer() {
    if (this.consumers.length <= 0) return;
    const c = this.consumers.pop()!;
    this.rebalance(`Consumer C${c.id} left the group`);
  }

  setPartitions(n: number) {
    // Changing partition count is disruptive in the real world; here we just
    // re-key and rebalance. Existing in-flight messages are cleared.
    const consumerCount = this.consumers.length;
    const producerCount = this.producers.length;
    this.reset(n);
    for (let i = 1; i < producerCount; i++) this.addProducer();
    for (let i = 1; i < consumerCount; i++) this.addConsumer();
    this.onEvent(`Topic re-created with ${n} partitions`, "info");
  }

  private rebalance(reason: string) {
    // Round-robin partition assignment across consumers. This mirrors the core
    // guarantee: a partition is owned by exactly one consumer in the group.
    for (const c of this.consumers) c.partitions = [];
    if (this.consumers.length > 0) {
      for (let p = 0; p < this.partitionCount; p++) {
        this.consumers[p % this.consumers.length].partitions.push(p);
      }
    }
    this.rebalancing = 1.1;
    this.lastRebalance = performance.now();
    void this.lastRebalance;
    this.onEvent(`Rebalance: ${reason}`, "warn");
  }

  consumerForPartition(p: number): Consumer | undefined {
    return this.consumers.find((c) => c.partitions.includes(p));
  }

  killBroker() {
    if (this.brokerDown) return;
    this.brokerDown = true;
    this.onEvent("Broker DOWN — leader unavailable", "bad");
  }

  restoreBroker() {
    if (!this.brokerDown) return;
    this.brokerDown = false;
    this.onEvent("Broker recovered", "info");
  }

  private emit(p: Producer) {
    const key = KEYS[Math.floor(Math.random() * KEYS.length)];
    const partition = hashKey(key, this.partitionCount);
    const msg: Message = {
      id: this.nextMsgId++,
      key,
      keyHue: hueForKey(key),
      partition,
      offset: -1,
      phase: "toBroker",
      progress: 0,
      bornAt: performance.now(),
      producerId: p.id,
      consumerId: -1,
    };
    this.messages.push(msg);
    this.metrics.produced++;
  }

  private commit(msg: Message) {
    if (this.brokerDown) {
      // Broker is down. Behaviour depends on acks:
      //  - acks=0: producer already "moved on"; the message is lost silently.
      //  - acks=1/all: the produce fails; with no retry the message drops, but
      //    with idempotence + retries it would survive. We model the honest
      //    default: dropped, and count it, so the failure is visible.
      msg.phase = "dropped";
      msg.progress = 0;
      this.metrics.dropped++;
      return;
    }
    const part = this.partitions[msg.partition];
    msg.offset = part.committedOffset++;
    part.log.push(msg.id);
    this.metrics.committed++;
    this.throughputWindow.push(performance.now());
    msg.phase = "inLog";
    msg.progress = 0;
  }

  update(dt: number) {
    if (this.paused) return;
    if (this.rebalancing > 0) this.rebalancing = Math.max(0, this.rebalancing - dt);

    // Rebuild the id lookup once per frame so ordering checks are always exact.
    this.idIndex.clear();
    for (const m of this.messages) this.idIndex.set(m.id, m);

    // Produce.
    for (const p of this.producers) {
      p.accumulator += p.rate * this.globalRate * dt;
      while (p.accumulator >= 1) {
        p.accumulator -= 1;
        // cap total in-flight to keep the canvas readable / fast
        if (this.messages.length < 260) this.emit(p);
      }
    }

    const commitSpeed = 2.2; // phase progress per second
    const flightSpeed = 1.6;

    for (const msg of this.messages) {
      switch (msg.phase) {
        case "toBroker":
          msg.progress += flightSpeed * dt;
          if (msg.progress >= 1) {
            msg.phase = "committing";
            msg.progress = 0;
          }
          break;
        case "committing": {
          const speed = msg.offset === -1 && this.acks === "all" ? commitSpeed * 0.6 : commitSpeed;
          msg.progress += speed * dt;
          if (msg.progress >= 1) this.commit(msg);
          break;
        }
        case "inLog": {
          // Wait for an owning consumer to pull it. Ordering within a partition
          // is enforced: only the lowest-offset in-log message is eligible.
          const consumer = this.consumerForPartition(msg.partition);
          if (!consumer) break; // no owner -> lag grows
          const part = this.partitions[msg.partition];
          const nextId = part.log.find((id) => {
            const m = this.byId(id);
            return m && m.phase === "inLog";
          });
          if (nextId === msg.id) {
            msg.phase = "toConsumer";
            msg.progress = 0;
            msg.consumerId = consumer.id;
          }
          break;
        }
        case "toConsumer":
          msg.progress += flightSpeed * dt;
          if (msg.progress >= 1) {
            msg.phase = "done";
            msg.progress = 0;
            this.metrics.consumed++;
            const c = this.consumers.find((x) => x.id === msg.consumerId);
            if (c) c.processed++;
          }
          break;
        case "done":
        case "dropped":
          msg.progress += dt; // linger briefly for the fade-out
          break;
      }
    }

    // Reap finished/dropped messages after their fade.
    this.messages = this.messages.filter((m) => {
      if (m.phase === "done" || m.phase === "dropped") return m.progress < 0.7;
      return true;
    });
    // Trim committed logs so lanes don't grow unbounded; keep recent tail.
    for (const part of this.partitions) {
      if (part.log.length > 400) part.log = part.log.slice(-200);
    }

    // Smoothed throughput over a 1s sliding window.
    const now = performance.now();
    this.throughputWindow = this.throughputWindow.filter((t) => now - t < 1000);
    this.metrics.throughput = this.throughputWindow.length;
  }

  private idIndex = new Map<number, Message>();
  byId(id: number): Message | undefined {
    return this.idIndex.get(id);
  }
}
