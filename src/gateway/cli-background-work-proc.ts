// Linux process table reader for the claude-cli background work view. It reads
// /proc once per sample and keeps just enough history between samples to tell a
// process tree that is working (new processes, CPU time going up) from one that
// sits still.
import fs from "node:fs";
import path from "node:path";

export type ProcInfo = {
  pid: number;
  ppid: number;
  comm: string;
  /** Kernel state letter: R running, S sleeping, D disk wait, Z zombie, T stopped. */
  state: string;
  startTicks: number;
  startedAt: number;
  cpuMs: number;
  argv: string[];
};

export type ProcSnapshot = {
  sampledAt: number;
  byPid: ReadonlyMap<number, ProcInfo>;
  children: ReadonlyMap<number, readonly number[]>;
  /** CPU percent of each process since the previous sample (one core = 100). */
  cpuPercent: ReadonlyMap<number, number>;
  /** Last time each process was seen using CPU, or its start when never seen. */
  lastBusyAt: ReadonlyMap<number, number>;
  readCwd: (pid: number) => string | undefined;
};

/** The parts of /proc the scanner reads; tests swap in a fake table. */
export type ProcReader = {
  listPids: () => number[];
  readStat: (pid: number) => string | undefined;
  readCmdline: (pid: number) => string | undefined;
  readCwd: (pid: number) => string | undefined;
  bootTimeMs: () => number | undefined;
  clockTicksPerSecond: number;
};

function readFileOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function createLinuxProcReader(procRoot = "/proc"): ProcReader {
  let bootTimeMs: number | undefined;
  return {
    listPids: () => {
      try {
        return fs
          .readdirSync(procRoot)
          .flatMap((name) => (/^\d+$/.test(name) ? [Number(name)] : []));
      } catch {
        return [];
      }
    },
    readStat: (pid) => readFileOrUndefined(path.join(procRoot, String(pid), "stat")),
    readCmdline: (pid) => readFileOrUndefined(path.join(procRoot, String(pid), "cmdline")),
    readCwd: (pid) => {
      try {
        return fs.readlinkSync(path.join(procRoot, String(pid), "cwd"));
      } catch {
        return undefined;
      }
    },
    bootTimeMs: () => {
      if (bootTimeMs === undefined) {
        const match = /^btime\s+(\d+)$/m.exec(
          readFileOrUndefined(path.join(procRoot, "stat")) ?? "",
        );
        bootTimeMs = match ? Number(match[1]) * 1000 : undefined;
      }
      return bootTimeMs;
    },
    // USER_HZ is 100 on every Linux architecture Node supports.
    clockTicksPerSecond: 100,
  };
}

type ParsedStat = Omit<ProcInfo, "pid" | "argv" | "startedAt"> & { startTicks: number };

/** Parses /proc/<pid>/stat. The command sits in parentheses and may hold spaces. */
export function parseProcStat(raw: string, clockTicksPerSecond: number): ParsedStat | undefined {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < open) {
    return undefined;
  }
  // Fields after the command, starting at field 3 (state).
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 20) {
    return undefined;
  }
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const startTicks = Number(fields[19]);
  if (![ppid, utime, stime, startTicks].every(Number.isFinite)) {
    return undefined;
  }
  return {
    comm: raw.slice(open + 1, close),
    state: fields[0] ?? "?",
    ppid,
    cpuMs: Math.round(((utime + stime) * 1000) / clockTicksPerSecond),
    startTicks,
  };
}

export function parseProcCmdline(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const parts = raw.split("\0");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  return parts;
}

type PreviousSample = {
  sampledAt: number;
  cpuByKey: Map<string, number>;
  lastBusyByKey: Map<string, number>;
};

/** Samples the process table, carrying CPU history from the previous sample. */
export function createProcSampler(reader: ProcReader) {
  let previous: PreviousSample | undefined;
  return (now: number): ProcSnapshot => {
    const bootTimeMs = reader.bootTimeMs() ?? 0;
    const byPid = new Map<number, ProcInfo>();
    const children = new Map<number, number[]>();
    const cpuPercent = new Map<number, number>();
    const lastBusyAt = new Map<number, number>();
    const cpuByKey = new Map<string, number>();
    const lastBusyByKey = new Map<string, number>();
    for (const pid of reader.listPids()) {
      const rawStat = reader.readStat(pid);
      const stat = rawStat ? parseProcStat(rawStat, reader.clockTicksPerSecond) : undefined;
      if (!stat) {
        continue;
      }
      const startedAt =
        bootTimeMs + Math.round((stat.startTicks * 1000) / reader.clockTicksPerSecond);
      const info: ProcInfo = {
        pid,
        ...stat,
        startedAt,
        argv: parseProcCmdline(reader.readCmdline(pid)),
      };
      byPid.set(pid, info);
      const siblings = children.get(stat.ppid) ?? [];
      siblings.push(pid);
      children.set(stat.ppid, siblings);
      // Pids are reused; the start time makes the key unique.
      const key = `${pid}:${stat.startTicks}`;
      cpuByKey.set(key, stat.cpuMs);
      const priorCpu = previous?.cpuByKey.get(key);
      // A process absent from the previous sample started after it: count from its start.
      // Without a previous sample, the lifetime average stands in.
      const since = priorCpu === undefined ? startedAt : previous!.sampledAt;
      const cpuDelta = stat.cpuMs - (priorCpu ?? 0);
      const wall = now - since;
      const percent = wall > 0 ? Math.max(0, Math.round((cpuDelta / wall) * 1000) / 10) : 0;
      cpuPercent.set(pid, percent);
      const busy = previous || priorCpu !== undefined ? cpuDelta > 0 : percent >= 1;
      const busyAt = busy ? now : (previous?.lastBusyByKey.get(key) ?? startedAt);
      lastBusyByKey.set(key, busyAt);
      lastBusyAt.set(pid, busyAt);
    }
    previous = { sampledAt: now, cpuByKey, lastBusyByKey };
    return { sampledAt: now, byPid, children, cpuPercent, lastBusyAt, readCwd: reader.readCwd };
  };
}

export function listDescendants(snapshot: ProcSnapshot, rootPid: number): ProcInfo[] {
  const out: ProcInfo[] = [];
  const stack = [...(snapshot.children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0 && out.length < 512) {
    const pid = stack.pop()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const info = snapshot.byPid.get(pid);
    if (info) {
      out.push(info);
      stack.push(...(snapshot.children.get(pid) ?? []));
    }
  }
  return out;
}

/** The process the tree is waiting on now: the deepest one, newest first on ties. */
export function findLeafProcess(snapshot: ProcSnapshot, root: ProcInfo): ProcInfo {
  let leaf = root;
  let leafDepth = 0;
  const visit = (pid: number, depth: number, guard: Set<number>) => {
    for (const childPid of snapshot.children.get(pid) ?? []) {
      const child = snapshot.byPid.get(childPid);
      if (!child || guard.has(childPid) || guard.size > 512) {
        continue;
      }
      guard.add(childPid);
      if (depth > leafDepth || (depth === leafDepth && child.startedAt > leaf.startedAt)) {
        leaf = child;
        leafDepth = depth;
      }
      visit(childPid, depth + 1, guard);
    }
  };
  visit(root.pid, 1, new Set([root.pid]));
  return leaf;
}
