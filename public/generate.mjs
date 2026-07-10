// generate.mjs — robust browser-driven Suno generation.
// Strategy C: drive the REAL suno.com/create page. When Suno doesn't require a
// challenge (passive pass, intermittent), clicking Create fires /api/generate
// directly → song created. When a challenge appears, best-effort solve it via
// 2Captcha. Retry on failure (challenges are intermittent, so retries often hit
// a no-challenge window).
//
// Usage (inside container):
//   docker exec suno-api-suno-api-1 node /app/public/generate.mjs "<prompt>" [instrumental:true|false]
// Outputs the generated clip IDs + audio URLs.

import axios from 'axios';
import cookie from 'cookie';
import { chromium } from 'rebrowser-playwright-core';
import { Solver } from '@2captcha/captcha-solver';

const CLERK = 'https://auth.suno.com';
const CLERK_VER = '5.117.0';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const log = (...a) => console.log('[gen]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = process.argv[2] || 'A calm lo-fi hip hop beat with soft piano and rainy night mood';
const INSTRUMENTAL = (process.argv[3] ?? 'false') !== 'false';
const MAX_ATTEMPTS = 5;

const cookies = cookie.parse(process.env.SUNO_COOKIE);
const cookieHeader = Object.entries(cookies).map(([k, v]) => cookie.serialize(k, v)).join('; ');
const solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
let authToken;

async function auth() {
  const headers = { Authorization: cookies.__client, Cookie: cookieHeader };
  const s = await axios.get(`${CLERK}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${CLERK_VER}`, { headers });
  const sid = s.data?.response?.last_active_session_id;
  if (!sid) throw new Error('no session id');
  const r = await axios.post(`${CLERK}/v1/client/sessions/${sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${CLERK_VER}`, {}, { headers });
  authToken = r.data.jwt;
}

// One browser-driven attempt. Returns { ok, clips, reason }.
async function oneAttempt(prompt, instrumental) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'], headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en', viewport: null });
    const ck = [{ name: '__session', value: String(authToken), domain: '.suno.com', path: '/', sameSite: 'Lax' }];
    for (const k in cookies) ck.push({ name: k, value: String(cookies[k]), domain: '.suno.com', path: '/', sameSite: 'Lax' });
    await ctx.addCookies(ck);
    const page = await ctx.newPage();

    let clips = null;
    page.on('response', async (resp) => {
      const u = resp.url();
      // Suno now posts to /api/generate/v2-web/ (not /api/generate/v2/).
      if (u.includes('/api/generate/v2') && resp.request().method() === 'POST') {
        try { const j = await resp.json(); clips = j.clips || j; log('/api/generate fired,', (clips || []).length, 'clips'); } catch (e) {}
      }
    });

    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 0 });
    await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 }).catch(() => {});
    await sleep(2500);

    if (instrumental) {
      await page.locator('button[aria-label="Check this to generate an instrumental only song"]').click().catch(() => {});
      await sleep(500);
    }
    const ta = 'textarea[maxlength="3000"]';
    await page.click(ta).catch(() => {});
    await page.fill(ta, prompt).catch(() => {});
    const btn = page.locator('button[aria-label="Create song"]');
    for (let i = 0; i < 40; i++) { if (!(await btn.isDisabled().catch(() => true))) break; await sleep(250); }
    await sleep(600);
    await page.screenshot({ path: '/app/public/recon/gen-typed.png' }).catch(() => {});
    await btn.click();
    log('clicked Create song');

    const frame = page.frameLocator('iframe[title*="hCaptcha"]');
    const deadline = Date.now() + 130000;
    while (Date.now() < deadline && !clips) {
      let hasChallenge = false;
      try { await frame.locator('.challenge-container').waitFor({ timeout: 1200 }); hasChallenge = true; } catch (e) {}
      if (hasChallenge) {
        log('hCaptcha challenge appeared — attempting solve');
        const ok = await solveChallenge(frame).catch((e) => { log('solve error:', e.message); return false; });
        if (!ok) return { ok: false, reason: 'captcha solve did not clear' };
        await sleep(2000);
      } else {
        await sleep(1200);
      }
    }
    if (clips) return { ok: true, clips };
    return { ok: false, reason: 'timeout (no /api/generate within 130s)' };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Best-effort multi-round hCaptcha solve via 2Captcha coordinates.
async function solveChallenge(frame) {
  const challenge = frame.locator('.challenge-container');
  for (let round = 0; round < 4; round++) {
    await sleep(1500);
    let promptText = '';
    try { promptText = await challenge.locator('.prompt-text').first().innerText({ timeout: 3000 }); } catch (e) {}
    const shot = await challenge.screenshot({ timeout: 5000 }).catch(() => null);
    if (!shot) { log('round', round, ': no challenge screenshot'); return false; }
    log('round', round, ': sending to 2Captcha (prompt:', JSON.stringify(promptText).slice(0, 50) + ')');
    let captcha;
    try {
      captcha = await solver.coordinates({ body: shot.toString('base64'), lang: 'en' });
    } catch (e) {
      log('round', round, ': 2Captcha error:', e.message);
      return false;
    }
    log('round', round, ': got', (captcha.data || []).length, 'points');
    for (const d of captcha.data || []) await challenge.click({ position: { x: +d.x, y: +d.y } }).catch(() => {});
    await frame.locator('.button-submit').click().catch(() => {});
    await sleep(3500);
    let still = false;
    try { still = await challenge.isVisible({ timeout: 1200 }); } catch (e) { still = false; }
    if (!still) { log('round', round, ': challenge cleared'); return true; }
    log('round', round, ': challenge still present, continuing');
  }
  return false;
}

// Poll the app's /api/get until clips are streaming/complete, return audio URLs.
async function waitForSongs(ids) {
  const idsParam = ids.join(',');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const { data } = await axios.get(`http://localhost:3000/api/get?ids=${idsParam}`, { timeout: 20000 });
      if (data.length && data.every((c) => ['streaming', 'complete', 'error'].includes(c.status))) return data;
    } catch (e) { log('poll error:', e.message); }
    await sleep(5000);
  }
  return [];
}

(async () => {
  await auth();
  log('prompt:', JSON.stringify(PROMPT), '| instrumental:', INSTRUMENTAL);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`=== attempt ${attempt}/${MAX_ATTEMPTS} ===`);
    const r = await oneAttempt(PROMPT, INSTRUMENTAL);
    if (r.ok) {
      const ids = (r.clips || []).map((c) => c.id);
      log('GENERATION SUBMITTED. clip ids:', ids.join(','));
      log('polling until ready...');
      const songs = await waitForSongs(ids);
      log('\n===== RESULT =====');
      if (!songs.length) { log('submitted but polling returned nothing; check /api/get?ids=' + ids.join(',')); }
      for (const s of songs) {
        log(`- [${s.status}] ${s.title}`);
        log(`    audio: ${s.audio_url}`);
      }
      return;
    }
    log('attempt failed:', r.reason);
    await sleep(3000);
  }
  log('ALL ATTEMPTS FAILED. Captcha likely required every time and solve did not clear; retry later or inspect recon screenshots.');
})().catch((e) => { console.error('[gen] FATAL', e); process.exit(1); });
