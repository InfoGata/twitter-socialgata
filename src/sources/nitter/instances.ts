/**
 * Nitter instances this plugin reads from, verified 2026-11-12 through the
 * InfoGata extension. Sources: https://status.d420.de/ and
 * https://gist.github.com/errant253/a876947ed253299752af8a7869dbb3b5
 *
 * Every host here must also be listed under `pageContextRequests` in
 * manifest.json -- most sit behind a bot check that only a real page on the
 * instance can pass, and the extension refuses a page-context request for a host
 * the manifest did not name.
 *
 * `search` is a capability, not a guess: several instances render the search
 * page but always return "No items found", which is indistinguishable from a
 * query with no results. Only instances seen returning results are marked.
 *
 * Left out on purpose:
 * - nitter.pp.ua, shitter.thepixora.com, nitter.miningtcup.me: DogWAF image
 *   CAPTCHA.
 * - nitter.click: Aragorn wants a click.
 * - nitter.kareem.one, xcopy.uk: a Cloudflare check that never cleared.
 * - nitter.mie.foundation: search always empty, profiles rate-limited.
 *
 * Those all need a person to get past, so trying them automatically would only
 * spend the request's time budget before failing.
 */
export interface NitterInstance {
  origin: string;
  search: boolean;
}

export const INSTANCES: NitterInstance[] = [
  { origin: "https://nitter.privacyredirect.com", search: true },
  { origin: "https://nitter.netbub.com", search: true },
  { origin: "https://nitter.r4fo.com", search: false },
  { origin: "https://nitter.jaydenha.uk", search: false },
  { origin: "https://nitter.catsarch.com", search: false },
  { origin: "https://ruf.st", search: false },
  // nitter.tiekoetter.com; search is disabled there.
  { origin: "https://xnologin.com", search: false },
];
