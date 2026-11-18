import type { Tone } from '../components/ui';
import { describeDaysLeft, diffDays } from './dates';

export type ExpiryStatus = { tone: Tone; text: string; daysLeft: number; level: 'expired' | 'soon' | 'fine' };

export function expiryStatus(expiryDate: string | null, today: string, leadDays: number): ExpiryStatus | null {
  if (!expiryDate) return null;
  const daysLeft = diffDays(expiryDate, today);
  if (daysLeft < 0) return { tone: 'danger', text: describeDaysLeft(daysLeft), daysLeft, level: 'expired' };
  if (daysLeft <= leadDays) return { tone: 'warn', text: describeDaysLeft(daysLeft), daysLeft, level: 'soon' };
  return { tone: 'ok', text: describeDaysLeft(daysLeft), daysLeft, level: 'fine' };
}

export function isLowStock(totalQty: number, threshold: number | null): boolean {
  return threshold !== null && threshold !== undefined && totalQty <= threshold;
}
