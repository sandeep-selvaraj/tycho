import { compareVersions, noteItems, type UpdateCheck } from '@tycho/core';
import type { Asset } from './installer';

/** Where releases are published. The update check and its download link never leave this repository. */
export const RELEASES_REPO = 'sandeep-selvaraj/tycho';
const LATEST = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
export const isReleaseUrl = (url: string) => url.startsWith(`https://github.com/${RELEASES_REPO}/releases/`);

/**
 * Ask GitHub for the latest published release and compare it with the running version.
 * Apart from downloading an update the user asked to install, this is the only network request
 * Tycho makes, and it sends nothing but the request itself.
 * Never throws: being offline is an answer, not a failure of the app.
 */
export async function checkForUpdates(current: string, fetcher: typeof fetch = fetch): Promise<UpdateCheck & { assets: Asset[] }> {
  const result = (rest: Partial<UpdateCheck & { assets: Asset[] }>) => ({
    current, checkedAt: new Date().toISOString(), available: false, latest: null, error: null,
    // Decided by the caller, which knows where this copy of the app is installed.
    install: { possible: false, reason: null }, assets: [], ...rest,
  });
  try {
    const res = await fetcher(LATEST, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Tycho' },
      signal: AbortSignal.timeout(10_000),
    });
    // No published release yet (or only drafts and pre-releases): nothing newer to offer.
    if (res.status === 404) return result({});
    if (!res.ok) return result({ error: `GitHub answered ${res.status}. Try again later.` });
    const r = (await res.json()) as { tag_name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown };
    if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string' || !isReleaseUrl(r.html_url)) {
      return result({ error: 'GitHub sent a release Tycho could not read.' });
    }
    const version = r.tag_name.replace(/^v/, '');
    const assets = (Array.isArray(r.assets) ? r.assets : []).flatMap((a: { name?: unknown; browser_download_url?: unknown; size?: unknown }) =>
      typeof a?.name === 'string' && typeof a.browser_download_url === 'string' ? [{ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }] : [],
    );
    return result({
      assets,
      available: compareVersions(version, current) > 0,
      latest: {
        version,
        items: noteItems(typeof r.body === 'string' ? r.body : '').slice(0, 40),
        url: r.html_url,
        publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
      },
    });
  } catch {
    return result({ error: 'Could not reach GitHub. Check your connection and try again.' });
  }
}
