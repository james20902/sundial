/**
 * Browser-mode backend.
 *
 * Running `npm run dev` outside Tauri serves this instead of the Rust store, so
 * the UI can be developed and tested in a plain browser. It implements the same
 * query semantics — including the min/max decimation — against a synthetic
 * flight, so a widget that looks right here looks right in the app.
 */

import type {
  ChannelStats,
  DatasetInfo,
  FlightEvent,
  RangeQuery,
} from "./types";

interface Column {
  name: string;
  unit: string | null;
  values: Float64Array;
}

interface MockDataset {
  info: DatasetInfo;
  times: Float64Array;
  columns: Map<string, Column>;
}

const RATE = 100; // control-loop Hz
const DURATION = 92; // seconds

function noise(seed: number): () => number {
  // Small deterministic PRNG: a fixed demo flight is far easier to eyeball
  // across reloads than a different one every time.
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** Synthesise a plausible high-power rocket flight. */
function buildFlight(): MockDataset {
  const n = Math.floor(RATE * DURATION);
  const times = new Float64Array(n);
  const rnd = noise(20260913);

  const mk = (name: string, unit: string | null): Column => ({
    name,
    unit,
    values: new Float64Array(n),
  });

  const cols = [
    mk("altitude", "m"),
    mk("velocity", "m/s"),
    mk("accel_z", "m/s^2"),
    mk("accel_x", "m/s^2"),
    mk("accel_y", "m/s^2"),
    mk("gyro_x", "deg/s"),
    mk("gyro_y", "deg/s"),
    mk("gyro_z", "deg/s"),
    mk("pressure", "Pa"),
    mk("temperature", "C"),
    mk("battery", "V"),
    mk("gps_lat", "deg"),
    mk("gps_lon", "deg"),
    mk("gps_sats", null),
    mk("rssi", "dBm"),
    mk("mach", null),
    mk("pyro_drogue", null),
    mk("pyro_main", null),
  ];
  const c = Object.fromEntries(cols.map((x) => [x.name, x.values])) as Record<
    string,
    Float64Array
  >;

  const T_LAUNCH = 5.0;
  const T_BURNOUT = 8.2;
  const T_APOGEE = 24.6;
  const T_DROGUE = 25.2;
  const T_MAIN = 62.0;
  const T_LAND = 88.4;

  let alt = 0;
  let vel = 0;

  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    times[i] = t;
    const dt = 1 / RATE;

    // Vertical dynamics, integrated so altitude and velocity stay consistent.
    let accel: number;
    if (t < T_LAUNCH) {
      accel = 0;
      vel = 0;
      alt = 0;
    } else if (t < T_BURNOUT) {
      const burn = (t - T_LAUNCH) / (T_BURNOUT - T_LAUNCH);
      accel = 92 * (1 - 0.45 * burn) - 9.81; // regressive thrust curve
    } else if (t < T_APOGEE) {
      const drag = 0.00018 * vel * Math.abs(vel);
      accel = -9.81 - drag;
    } else if (t < T_DROGUE) {
      accel = -9.81;
    } else if (t < T_MAIN) {
      accel = (-24 - vel) * 1.6; // drogue drives toward -24 m/s
    } else if (t < T_LAND) {
      accel = (-6.4 - vel) * 1.1; // main drives toward -6.4 m/s
    } else {
      accel = 0;
      vel = 0;
    }

    if (t >= T_LAUNCH && t < T_LAND) {
      vel += accel * dt;
      alt += vel * dt;
      if (alt < 0) {
        alt = 0;
        vel = 0;
      }
    }

    const jitter = t > T_LAUNCH && t < T_APOGEE ? 1.4 : 0.25;
    c.altitude[i] = alt + rnd() * jitter * 0.6;
    c.velocity[i] = vel + rnd() * jitter;
    // The accelerometer reads specific force: 1 g on the pad, ~0 in freefall.
    c.accel_z[i] =
      (t < T_LAUNCH ? 9.81 : t < T_BURNOUT ? accel + 9.81 : t < T_DROGUE ? 0.4 : 9.81 * 0.9) +
      rnd() * (t > T_LAUNCH && t < T_BURNOUT ? 4 : 0.8);
    c.accel_x[i] = rnd() * (t > T_LAUNCH && t < T_BURNOUT ? 3.5 : 0.5);
    c.accel_y[i] = rnd() * (t > T_LAUNCH && t < T_BURNOUT ? 3.5 : 0.5);

    // Roll builds during boost, then the airframe coasts with slow precession.
    const spin = t < T_LAUNCH ? 0 : t < T_BURNOUT ? 40 * (t - T_LAUNCH) : 130;
    c.gyro_z[i] = (t < T_DROGUE ? spin : 220 * Math.sin(t * 3.1)) + rnd() * 6;
    c.gyro_x[i] = (t < T_DROGUE ? 8 * Math.sin(t * 1.7) : 90 * Math.sin(t * 2.3)) + rnd() * 5;
    c.gyro_y[i] = (t < T_DROGUE ? 8 * Math.cos(t * 1.9) : 90 * Math.cos(t * 2.1)) + rnd() * 5;

    c.pressure[i] = 101325 * Math.exp(-alt / 8434) + rnd() * 22;
    c.temperature[i] = 21.5 - alt * 0.0065 + rnd() * 0.3;
    c.battery[i] =
      8.31 - t * 0.0021 - (t > T_LAUNCH && t < T_BURNOUT ? 0.22 : 0) + rnd() * 0.012;

    c.gps_lat[i] = 32.94021 + alt * 1e-7 + rnd() * 2e-6;
    c.gps_lon[i] = -106.92198 + t * 1.4e-6 + rnd() * 2e-6;
    // Lock degrades under boost acceleration, as it does on real flights.
    c.gps_sats[i] = t < T_LAUNCH ? 11 : t < T_BURNOUT ? 4 : Math.min(11, 5 + (t - T_BURNOUT) * 0.4);
    c.rssi[i] = -62 - alt * 0.011 + rnd() * 3.5;
    c.mach[i] = Math.max(0, vel) / 330;
    c.pyro_drogue[i] = t >= T_DROGUE && t < T_DROGUE + 0.35 ? 1 : 0;
    c.pyro_main[i] = t >= T_MAIN && t < T_MAIN + 0.35 ? 1 : 0;
  }

  const events: FlightEvent[] = [
    { t: 0, label: "state: PAD", kind: "state" },
    { t: T_LAUNCH, label: "state: BOOST", kind: "state" },
    { t: T_BURNOUT, label: "state: COAST", kind: "state" },
    { t: T_APOGEE, label: `Apogee ${Math.round(alt)}`, kind: "detected" },
    { t: T_DROGUE, label: "state: DROGUE", kind: "state" },
    { t: T_MAIN, label: "state: MAIN", kind: "state" },
    { t: T_LAND, label: "state: LANDED", kind: "state" },
  ];

  const columns = new Map(cols.map((x) => [x.name, x]));
  // Recompute apogee from the integrated trace rather than trusting the loop's
  // final `alt`, which is ground level by the time the loop ends.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, c.altitude[i]);
  events[3] = { t: T_APOGEE, label: `Apogee ${peak.toFixed(0)}`, kind: "detected" };

  const info: DatasetInfo = {
    id: "mock1",
    name: "demo-flight-l1850.csv",
    source: "built-in demo flight (browser mode)",
    t0: 0,
    t1: (n - 1) / RATE,
    frames: n,
    live: false,
    channels: cols.map((col) => {
      let min = Infinity;
      let max = -Infinity;
      let count = 0;
      for (const v of col.values) {
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
          count++;
        }
      }
      return {
        name: col.name,
        unit: col.unit,
        min: count ? min : 0,
        max: count ? max : 0,
        count,
      };
    }),
    events,
  };

  return { info, times, columns };
}

let flight: MockDataset | null = null;
function data(): MockDataset {
  if (!flight) flight = buildFlight();
  return flight;
}

function rangeIndices(times: Float64Array, t0: number, t1: number): [number, number] {
  let lo = 0;
  let hi = times.length;
  // Mirrors the Rust partition_point pair, including the one-frame overscan
  // that keeps plotted lines reaching the edges of the window.
  let a = 0;
  let b = times.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (times[m] < t0) a = m + 1;
    else b = m;
  }
  lo = a;
  a = 0;
  b = times.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (times[m] <= t1) a = m + 1;
    else b = m;
  }
  hi = a;
  return [Math.max(0, lo - 1), Math.min(times.length, hi + 1)];
}

export function mockQueryRange(
  channels: string[],
  t0: number,
  t1: number,
  maxPoints: number,
): RangeQuery {
  const d = data();
  const [lo, hi] = rangeIndices(d.times, t0, t1);
  const n = Math.max(0, hi - lo);
  const picked = channels.map((c) => d.columns.get(c)).filter(Boolean) as Column[];

  if (n === 0) {
    return {
      times: [],
      series: picked.map((c) => ({ name: c.name, unit: c.unit, values: [] })),
      sourceFrames: 0,
      decimated: false,
    };
  }

  const cap = Math.max(4, maxPoints);
  if (n <= cap) {
    return {
      times: Array.from(d.times.slice(lo, hi)),
      series: picked.map((c) => ({
        name: c.name,
        unit: c.unit,
        values: Array.from(c.values.slice(lo, hi)).map((v) => (Number.isFinite(v) ? v : null)),
      })),
      sourceFrames: n,
      decimated: false,
    };
  }

  const buckets = Math.floor(cap / 2);
  const times: number[] = [];
  const out = picked.map(() => [] as (number | null)[]);

  for (let b = 0; b < buckets; b++) {
    const bs = lo + Math.floor((n * b) / buckets);
    const be = Math.min(hi, Math.max(bs + 1, lo + Math.floor((n * (b + 1)) / buckets)));
    times.push(d.times[bs], d.times[be - 1]);

    picked.forEach((col, slot) => {
      let minV = Infinity;
      let maxV = -Infinity;
      let minI = -1;
      let maxI = -1;
      for (let k = bs; k < be; k++) {
        const v = col.values[k];
        if (!Number.isFinite(v)) continue;
        if (v < minV) {
          minV = v;
          minI = k;
        }
        if (v > maxV) {
          maxV = v;
          maxI = k;
        }
      }
      if (minI < 0) out[slot].push(null, null);
      else if (minI <= maxI) out[slot].push(minV, maxV);
      else out[slot].push(maxV, minV);
    });
  }

  return {
    times,
    series: picked.map((c, i) => ({ name: c.name, unit: c.unit, values: out[i] })),
    sourceFrames: n,
    decimated: true,
  };
}

export function mockIndexAt(t: number): number {
  const d = data();
  let a = 0;
  let b = d.times.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (d.times[m] <= t) a = m + 1;
    else b = m;
  }
  return Math.max(0, a - 1);
}

export function mockSampleAt(t: number, channels: string[]): (number | null)[] {
  const d = data();
  const i = mockIndexAt(t);
  return channels.map((name) => {
    const col = d.columns.get(name);
    if (!col) return null;
    const v = col.values[Math.min(i, col.values.length - 1)];
    return Number.isFinite(v) ? v : null;
  });
}

export function mockStats(channels: string[], t0: number, t1: number): ChannelStats[] {
  const d = data();
  const [lo, hi] = rangeIndices(d.times, t0, t1);
  return channels
    .map((name) => {
      const col = d.columns.get(name);
      if (!col) return null;
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      let tMin = 0;
      let tMax = 0;
      let first: number | null = null;
      let last: number | null = null;
      for (let i = lo; i < hi; i++) {
        const v = col.values[i];
        if (!Number.isFinite(v)) continue;
        count++;
        sum += v;
        if (v < min) {
          min = v;
          tMin = d.times[i];
        }
        if (v > max) {
          max = v;
          tMax = d.times[i];
        }
        if (first === null) first = v;
        last = v;
      }
      if (!count) {
        return {
          name,
          unit: col.unit,
          count: 0,
          min: null,
          max: null,
          mean: null,
          stddev: null,
          first: null,
          last: null,
          tMin: null,
          tMax: null,
        } satisfies ChannelStats;
      }
      const mean = sum / count;
      let varSum = 0;
      for (let i = lo; i < hi; i++) {
        const v = col.values[i];
        if (Number.isFinite(v)) varSum += (v - mean) ** 2;
      }
      return {
        name,
        unit: col.unit,
        count,
        min,
        max,
        mean,
        stddev: Math.sqrt(varSum / count),
        first,
        last,
        tMin,
        tMax,
      } satisfies ChannelStats;
    })
    .filter(Boolean) as ChannelStats[];
}

export function mockInfo(): DatasetInfo {
  return structuredClone(data().info);
}

export function mockAddEvent(e: FlightEvent): FlightEvent[] {
  const d = data();
  d.info.events = [...d.info.events, e].sort((a, b) => a.t - b.t);
  return structuredClone(d.info.events);
}

export function mockRemoveMarker(t: number): FlightEvent[] {
  const d = data();
  d.info.events = d.info.events.filter(
    (e) => !(e.kind === "marker" && Math.abs(e.t - t) < 1e-9),
  );
  return structuredClone(d.info.events);
}
