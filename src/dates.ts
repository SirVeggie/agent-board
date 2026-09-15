/** Unix ms on disk; local ISO (with offset) when talking to the agent. */
export function toLocalIso(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const d = new Date(ms);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function withAgentDates<T extends { createdAt: number; updatedAt: number; archivedAt?: number; stateUpdatedAt?: number }>(
  tab: T
): Omit<T, "createdAt" | "updatedAt" | "archivedAt" | "stateUpdatedAt"> & {
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  stateUpdatedAt?: string;
} {
  const { createdAt, updatedAt, archivedAt, stateUpdatedAt, ...rest } = tab;
  return {
    ...rest,
    createdAt: toLocalIso(createdAt),
    updatedAt: toLocalIso(updatedAt),
    ...(archivedAt ? { archivedAt: toLocalIso(archivedAt) } : {}),
    ...(typeof stateUpdatedAt === "number" && stateUpdatedAt > 0 ? { stateUpdatedAt: toLocalIso(stateUpdatedAt) } : {}),
  };
}
