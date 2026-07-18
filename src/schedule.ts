import { redeemLeadTimeMs } from "./config";

export type ResetCredit = {
  id: string;
  status: string;
  expires_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResetCredits(value: unknown): ResetCredit[] {
  if (!isRecord(value) || !Array.isArray(value.credits)) {
    throw new Error("Reset-credit response must contain a credits array");
  }

  return value.credits.flatMap((row): ResetCredit[] => {
    if (!isRecord(row)
      || typeof row.id !== "string" || row.id.trim() === ""
      || typeof row.status !== "string"
      || typeof row.expires_at !== "string"
      || !Number.isFinite(Date.parse(row.expires_at))) {
      return [];
    }
    return [{ id: row.id, status: row.status, expires_at: row.expires_at }];
  });
}

export function selectDueCredit(
  credits: ResetCredit[],
  consumedIds: Set<string>,
  nowMs: number,
): ResetCredit | undefined {
  return credits
    .flatMap((credit) => {
      const expiresMs = Date.parse(credit.expires_at);
      if (credit.status !== "available"
        || consumedIds.has(credit.id)
        || !Number.isFinite(expiresMs)
        || nowMs < expiresMs - redeemLeadTimeMs()
        || nowMs >= expiresMs) {
        return [];
      }
      return [{ credit, expiresMs }];
    })
    .sort((a, b) => a.expiresMs - b.expiresMs || a.credit.id.localeCompare(b.credit.id))[0]?.credit;
}

export function earliestAvailableExpiry(credits: ResetCredit[], nowMs: number): string | undefined {
  return credits
    .filter((credit) => credit.status === "available" && Date.parse(credit.expires_at) > nowMs)
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0]?.expires_at;
}
