import fallback from '@data/fx_fallback.json';
import type { Currency } from './types';

/**
 * Display currencies. The simulation works in USD; the UI converts with live rates from
 * frankfurter.dev (ECB data, no key), cached for 12 hours, with a bundled offline fallback.
 */
const KEY = 'skyempire.fx.v1';
const SYMBOL: Record<Currency, string> = { GBP: '£', USD: '$', EUR: '€', ZAR: 'R' };
let rates: Record<Currency, number> = { ...(fallback.rates as Record<Currency, number>) };
let source = `offline rates (${fallback.date})`;

export async function loadRates(): Promise<string> {
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (cached && Date.now() - cached.at < 12 * 3600_000) {
      rates = { ...rates, ...cached.rates };
      source = `live rates (${cached.date})`;
      return source;
    }
  } catch {
    /* ignore */
  }
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR,ZAR');
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    rates = { ...rates, ...j.rates, USD: 1 };
    source = `live rates (${j.date})`;
    try {
      localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), date: j.date, rates: j.rates }));
    } catch {
      /* ignore */
    }
  } catch {
    source = `offline rates (${fallback.date})`;
  }
  return source;
}

export const ratesSource = () => source;
export const toCurrency = (usd: number, c: Currency) => usd * (rates[c] ?? 1);
export const fromCurrency = (v: number, c: Currency) => v / (rates[c] ?? 1);
export const symbol = (c: Currency) => SYMBOL[c];

/** Format a USD amount in the display currency: compact (£1.2M) or full (£1,234,567). */
export function money(usd: number, c: Currency, compact = true): string {
  const v = toCurrency(usd, c);
  const s = SYMBOL[c];
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (!compact) return `${sign}${s}${Math.round(a).toLocaleString('en-GB')}`;
  if (a >= 1e12) return `${sign}${s}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}${s}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${s}${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}${s}${(a / 1e3).toFixed(0)}k`;
  return `${sign}${s}${a.toFixed(0)}`;
}
