'use strict';
/**
 * Captcha and bot-check providers.
 *
 * A challenge widget is the one thing on a page that must never be optimised
 * away: block its images and you get an empty puzzle grid, block its fonts and
 * the buttons land on top of each other, block its audio and the accessibility
 * option is gone. Every one of those looks to the user like "the captcha will
 * not load", and none of them is a saving worth having - a challenge is a few
 * hundred kilobytes you only pay once.
 *
 * So these hosts are carved out of bandwidth blocking, and their origins are
 * allowed to keep images and third-party cookies even when the rest of the
 * session is not.
 */

/**
 * Hostname suffixes. A URL matches when its host is one of these or a
 * subdomain of one.
 */
const HOSTS = [
  // hCaptcha (accounts, api, newassets, imgs, ...)
  'hcaptcha.com',
  // reCAPTCHA served from its own domain; the google.com/gstatic.com copies
  // are matched by path instead, so the carve-out cannot swallow all of Google.
  'recaptcha.net',
  'recaptcha.google.com',
  'recaptchaenterprise.googleapis.com',
  // Cloudflare Turnstile and the managed-challenge island
  'challenges.cloudflare.com',
  // Arkose Labs / FunCaptcha - the usual choice behind Auth0 signup flows
  'arkoselabs.com',
  'arkoselabs.cn',
  'arkoselabs.co',
  'funcaptcha.com',
  'funcaptcha.co',
  // GeeTest
  'geetest.com',
  'geevisit.com',
  'gsensebot.com',
  // Friendly Captcha
  'friendlycaptcha.com',
  'friendlycaptcha.eu',
  // DataDome
  'captcha-delivery.com',
  'datadome.co',
  // PerimeterX / HUMAN
  'perimeterx.net',
  'px-cdn.net',
  'px-cloud.net',
  'pxchk.net',
  // AWS WAF captcha
  'awswaf.com',
  // Auth0 hosts the loader for whichever provider a tenant picked
  'cdn.auth0.com',
  // Yandex SmartCaptcha
  'smartcaptcha.yandexcloud.net',
];

/**
 * Path fragments that identify a challenge on a host that serves plenty of
 * other things too. Matched case-insensitively against the whole URL.
 */
const PATHS = [
  '/recaptcha/',
  '/turnstile/',
  '/cdn-cgi/challenge-platform/',
  '/hcaptcha',
  '/captcha/',
  '/captcha?',
];

/**
 * Origins allowed to keep images and third-party cookies, as Chromium content
 * setting patterns. These are coarser than the URL matcher above - a content
 * setting cannot look at a path - so google.com and gstatic.com are the price
 * of a working reCAPTCHA. Turn `bandwidth.allowChallenges` off to drop them.
 */
const ORIGIN_PATTERNS = [
  '[*.]hcaptcha.com',
  '[*.]recaptcha.net',
  '[*.]google.com',
  '[*.]gstatic.com',
  'challenges.cloudflare.com',
  '[*.]arkoselabs.com',
  '[*.]funcaptcha.com',
  '[*.]geetest.com',
  '[*.]friendlycaptcha.com',
  '[*.]captcha-delivery.com',
  '[*.]datadome.co',
  '[*.]perimeterx.net',
  '[*.]px-cdn.net',
  '[*.]awswaf.com',
  '[*.]auth0.com',
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Is this host one of the providers, or a subdomain of one? */
function isChallengeHost(host) {
  if (!host) return false;
  return HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Does this URL belong to a captcha or bot check?
 * Used to decide whether a frame keeps the full bandwidth blocklist.
 */
function isChallengeUrl(url) {
  if (!url) return false;
  if (isChallengeHost(hostOf(url))) return true;
  const lower = String(url).toLowerCase();
  return PATHS.some((p) => lower.includes(p));
}

module.exports = { HOSTS, PATHS, ORIGIN_PATTERNS, isChallengeHost, isChallengeUrl };
