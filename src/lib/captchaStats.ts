import axios from 'axios';
import pino from 'pino';
import { promises as fs } from 'fs';
import path from 'node:path';

const logger = pino();

// Where the running tally is persisted. Mount this path as a volume in Docker
// (e.g. ./data:/app/data) so the counters survive container restarts.
const STATS_FILE =
  process.env.CAPTCHA_STATS_FILE || path.join(process.cwd(), 'data', 'captcha-stats.json');

// 2Captcha Click/Coordinates method price per 1000 solves. Override with the
// env var if you ever switch method or provider.
const PRICE_PER_1000 =
  Number(process.env.TWOCAPTCHA_PRICE_PER_1000) > 0
    ? Number(process.env.TWOCAPTCHA_PRICE_PER_1000)
    : 1.2;
const PRICE_PER_SOLVE = PRICE_PER_1000 / 1000;

interface CaptchaStats {
  total_solves: number;
  bad_reports: number;
  first_balance: number | null;
  last_balance: number | null;
  last_balance_at: string | null;
  created_at: string;
  updated_at: string;
}

const defaultStats = (): CaptchaStats => ({
  total_solves: 0,
  bad_reports: 0,
  first_balance: null,
  last_balance: null,
  last_balance_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

async function readStats(): Promise<CaptchaStats> {
  try {
    const raw = await fs.readFile(STATS_FILE, 'utf-8');
    return { ...defaultStats(), ...JSON.parse(raw) };
  } catch {
    return defaultStats();
  }
}

async function writeStats(stats: CaptchaStats): Promise<void> {
  stats.updated_at = new Date().toISOString();
  try {
    await fs.mkdir(path.dirname(STATS_FILE), { recursive: true });
    await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e: any) {
    logger.info(`Failed to persist captcha stats: ${e.message}`);
  }
}

/**
 * Increment the successful-solve counter. Call once per solved CAPTCHA image.
 */
export async function recordSolve(): Promise<void> {
  const stats = await readStats();
  stats.total_solves += 1;
  await writeStats(stats);
}

/**
 * Increment the bad-report counter. A bad-reported solve is refunded by
 * 2Captcha, so it is excluded from the estimated spend.
 */
export async function recordBadReport(): Promise<void> {
  const stats = await readStats();
  stats.bad_reports += 1;
  await writeStats(stats);
}

/**
 * Query the live 2Captcha account balance (ground truth for real money spent).
 * Returns null if the key is missing or the request fails.
 */
export async function fetchBalance(apiKey?: string): Promise<number | null> {
  if (!apiKey) return null;
  try {
    const { data } = await axios.get('https://2captcha.com/res.php', {
      params: { key: apiKey, action: 'getbalance', json: 1 },
      timeout: 15000,
    });
    if (data && data.status === 1) return Number(data.request);
    logger.info(`2Captcha balance request failed: ${data?.request}`);
    return null;
  } catch (e: any) {
    logger.info(`2Captcha balance request error: ${e.message}`);
    return null;
  }
}

/**
 * Build the full statistics report, refreshing the live balance and capturing
 * the first-seen balance so we can report the real money delta.
 */
export async function getCaptchaStats(): Promise<object> {
  const apiKey = process.env.TWOCAPTCHA_KEY + '';
  const stats = await readStats();
  const currentBalance = await fetchBalance(apiKey);

  // Capture the balance the first time we see it, so balance-based spend is
  // measured from the start of tracking.
  if (stats.first_balance === null && currentBalance !== null) {
    stats.first_balance = currentBalance;
  }
  if (currentBalance !== null) {
    stats.last_balance = currentBalance;
    stats.last_balance_at = new Date().toISOString();
  }
  await writeStats(stats);

  const netSolves = Math.max(0, stats.total_solves - stats.bad_reports);
  const estimatedSpend = +(netSolves * PRICE_PER_SOLVE).toFixed(6);
  const balanceSpend =
    stats.first_balance !== null && currentBalance !== null
      ? +(stats.first_balance - currentBalance).toFixed(6)
      : null;

  return {
    solver: '2captcha',
    method: 'coordinates',
    pricing: {
      price_per_1000: PRICE_PER_1000,
      price_per_solve: PRICE_PER_SOLVE,
    },
    solves: {
      total: stats.total_solves,
      bad_reported: stats.bad_reports,
      net_billable: netSolves,
    },
    spend_usd: {
      estimated: estimatedSpend, // counter-based: net_solves × price
      balance_based: balanceSpend, // real money delta since first seen
    },
    balance_usd: {
      current: currentBalance,
      first_seen: stats.first_balance,
    },
    last_balance_at: stats.last_balance_at,
    created_at: stats.created_at,
    updated_at: stats.updated_at,
  };
}
