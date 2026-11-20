import { CARREFOUR_ORIGIN, IAM_ORIGIN, SessionService, sessionService } from './session.service.js';
import { browserService, isProfileLocked } from './browser.service.js';
import { logger } from '../utils/logger.js';

/**
 * Carrefour authentication, as observed on the live site.
 *
 * Logging in goes through ForgeRock AM (`moncompte.carrefour.fr/iam`) and ends
 * with two independent sessions:
 *
 *   1. the IAM SSO session, carried by the `c4iamsecuretk` cookie on
 *      `moncompte.carrefour.fr` — max 24 h, and killed after 60 min idle;
 *   2. the storefront session, carried by httpOnly cookies on
 *      `www.carrefour.fr`, which the BFF mints from an OAuth2 authorization
 *      code.
 *
 * Only step 1 needs a human: it is gated by a Cloudflare Turnstile captcha and
 * an email OTP. Step 2 is a plain redirect chain, so as long as the SSO cookie
 * is alive the storefront session can be rebuilt headlessly — that is what
 * `refreshSession()` does, and it is our equivalent of a refresh token.
 */

const CLIENT_ID = process.env.CARREFOUR_OAUTH_CLIENT_ID || 'carrefour_onecarrefour_web';
const REDIRECT_URI = process.env.CARREFOUR_OAUTH_REDIRECT_URI || `${CARREFOUR_ORIGIN}/login/check`;
const SCOPE = process.env.CARREFOUR_OAUTH_SCOPE || 'openid iam';
export function authorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
  });
  return `${IAM_ORIGIN}/iam/oauth2/CarrefourConnect/authorize?${params.toString()}`;
}

/** A cheap authenticated call, used to tell whether the storefront session is alive. */
export const PROBE_URL = `${CARREFOUR_ORIGIN}/api/user/secured/loyalty/balance`;

export type RefreshFailure = 'no-sso' | 'sso-expired' | 'browser-busy' | 'network';

/**
 * The SSO token ForgeRock last refused. Replaying the OAuth chain with it again
 * cannot work, so we wait for a new login (a new token) before trying again.
 * Observed on 2026-11-20: with a dead token the old keep-alive failed every
 * 30 min for days, while the storefront session itself never expired.
 */
let deadSsoToken: string | null = null;

export function resetDeadSso(): void {
  deadSsoToken = null;
}

export interface RefreshResult {
  ok: boolean;
  reason?: RefreshFailure;
  message: string;
}

/**
 * Landing back on the storefront means the whole chain went through:
 * authorize -> /login/check?code=... -> www. Being left on the IAM host means
 * ForgeRock asked for credentials instead, i.e. the SSO session is gone.
 */
function landedOnStorefront(finalUrl: string): boolean {
  try {
    return new URL(finalUrl).origin === CARREFOUR_ORIGIN;
  } catch {
    return false;
  }
}

async function doRefresh(session: SessionService): Promise<RefreshResult> {
  if (!session.hasSso()) {
    return {
      ok: false,
      reason: 'no-sso',
      message:
        'No IAM SSO cookie (c4iamsecuretk) in the browser profile, so the storefront session ' +
        'cannot be rebuilt. Run carrefour_browser_login to sign in again.',
    };
  }

  const token = session.getSsoToken();
  if (token !== null && token === deadSsoToken) {
    return {
      ok: false,
      reason: 'sso-expired',
      message:
        'The IAM SSO session already expired and nobody signed in since, so the storefront session ' +
        'cannot be rebuilt. Sign in again with carrefour_browser_login (captcha + email OTP).',
    };
  }

  let landing: { status: number | null; finalUrl: string };
  try {
    // Chromium walks the redirect chain and stores the cookies itself.
    landing = await browserService.navigate(authorizeUrl());
  } catch (error) {
    logger.error('Session refresh failed', { error: String(error) });
    if (isProfileLocked(error)) {
      return {
        ok: false,
        reason: 'browser-busy',
        message: 'The browser profile is held by another copy of the server; the session itself may be fine.',
      };
    }
    return { ok: false, reason: 'network', message: `Session refresh failed: ${(error as Error).message}` };
  }

  if (!landedOnStorefront(landing.finalUrl)) {
    logger.error('Session refresh stopped short of the storefront', { finalUrl: landing.finalUrl });
    deadSsoToken = token;
    return {
      ok: false,
      reason: 'sso-expired',
      message:
        'The IAM SSO session is no longer valid (it expires after 60 min idle, 24 h max), so no ' +
        'authorization code was issued. Sign in again with carrefour_browser_login — Carrefour ' +
        'requires a captcha and an email OTP, which cannot be scripted.',
    };
  }

  session.persist();
  logger.info('Session refreshed', { finalUrl: landing.finalUrl, status: landing.status });
  return { ok: true, message: 'Storefront session refreshed from the IAM SSO cookie.' };
}

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Rebuild the storefront session from the SSO cookie. Concurrent callers share
 * one round-trip: a burst of 401s must not trigger a burst of re-authentications.
 */
export function refreshSession(session: SessionService = sessionService): Promise<RefreshResult> {
  if (!inFlight) {
    inFlight = doRefresh(session).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export interface SsoStatus {
  present: boolean;
  /** Seconds before the SSO session dies of old age, when the server tells us. */
  secondsLeft?: number;
  /** Idle timeout in minutes, after which the SSO session dies early. */
  maxIdleMinutes?: number;
  error?: string;
}

/** Ask ForgeRock how much life is left in the SSO session. */
export async function ssoStatus(session: SessionService = sessionService): Promise<SsoStatus> {
  if (!session.hasSso()) return { present: false };

  const call = async (action: string): Promise<Record<string, number> | null> => {
    const response = await browserService.fetch({
      method: 'POST',
      url: `${IAM_ORIGIN}/iam/json/sessions/?_action=${action}`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-api-version': 'resource=1.1',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: '{}',
    });
    if (!response.ok) return null;
    try {
      return JSON.parse(response.text) as Record<string, number>;
    } catch {
      return null;
    }
  };

  try {
    const [timeLeft, maxIdle] = await Promise.all([call('getTimeLeft'), call('getMaxIdle')]);
    return {
      present: true,
      secondsLeft: timeLeft?.maxtime,
      maxIdleMinutes: maxIdle?.maxidletime,
    };
  } catch (error) {
    return { present: true, error: (error as Error).message };
  }
}

let keepAliveTimer: NodeJS.Timeout | null = null;

export type KeepAliveOutcome = 'alive' | 'refreshed' | 'expired' | 'skipped' | 'error';

/** Probe the storefront session and only rebuild it from the SSO when it is gone. */
export async function keepAliveTick(session: SessionService = sessionService): Promise<KeepAliveOutcome> {
  if (!session.hasSession() && !session.hasSso()) return 'skipped';
  try {
    const probe = await browserService.fetch({
      method: 'GET',
      url: PROBE_URL,
      headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' },
    });
    if (probe.status !== 401 && probe.status !== 403) {
      await browserService.syncCookies();
      return 'alive';
    }
  } catch (error) {
    logger.error('Keep-alive probe failed', { error: String(error) });
    return 'error';
  }
  if (!session.hasSso()) return 'expired';
  const result = await refreshSession(session);
  return result.ok ? 'refreshed' : result.reason === 'sso-expired' || result.reason === 'no-sso' ? 'expired' : 'error';
}

/**
 * Keep the storefront session in use. Measured on 2026-11-20: the www.carrefour.fr
 * session stayed valid for 5 days of regular use, long after the IAM SSO session
 * (60 min idle, 24 h max) had died. So the timer touches the storefront, and only
 * falls back to the OAuth chain when the storefront actually says 401.
 *
 * Set CARREFOUR_KEEPALIVE_MINUTES=0 to opt out.
 */
export function startKeepAlive(session: SessionService = sessionService): void {
  const minutes = parseInt(process.env.CARREFOUR_KEEPALIVE_MINUTES || '30', 10);
  if (!Number.isFinite(minutes) || minutes <= 0 || keepAliveTimer) return;

  let last: KeepAliveOutcome | null = null;
  keepAliveTimer = setInterval(() => {
    keepAliveTick(session)
      .then((outcome) => {
        // Log changes, not every tick: a dead session used to fill error.log.
        if (outcome !== last) logger.info('Keep-alive', { outcome });
        last = outcome;
      })
      .catch((error) => logger.error('Keep-alive failed', { error: String(error) }));
  }, minutes * 60_000);

  // Never hold the process open just for the keep-alive.
  keepAliveTimer.unref?.();
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}
