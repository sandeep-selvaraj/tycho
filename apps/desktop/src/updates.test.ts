import { describe, expect, it } from 'vitest';
import { checkForUpdates } from './updates';

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const release = (tag: string) => ({
  tag_name: tag, published_at: '2026-11-20T10:00:00Z', html_url: `https://github.com/sandeep-selvaraj/tycho/releases/tag/${tag}`,
  body: "## What's new\n\n- **Costs view.** New.\n- Fixed running sessions.\n\n---\nUnsigned builds.",
});

describe('update check', () => {
  it('offers a newer release with its notes', async () => {
    const r = await checkForUpdates('0.1.0', reply(200, release('v0.2.0')));
    expect(r).toMatchObject({ current: '0.1.0', available: true, error: null, latest: { version: '0.2.0', items: ['Costs view. New.', 'Fixed running sessions.'] } });
  });

  it('says so when the running version is the latest, or ahead of it', async () => {
    expect((await checkForUpdates('0.2.0', reply(200, release('v0.2.0')))).available).toBe(false);
    expect((await checkForUpdates('0.3.0', reply(200, release('v0.2.0')))).available).toBe(false);
  });

  it('treats "no release published yet" as up to date', async () => {
    expect(await checkForUpdates('0.1.0', reply(404, { message: 'Not Found' }))).toMatchObject({ available: false, latest: null, error: null });
  });

  it('reports being offline or rate-limited instead of throwing', async () => {
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect((await checkForUpdates('0.1.0', offline)).error).toMatch(/reach GitHub/);
    expect((await checkForUpdates('0.1.0', reply(403, {}))).error).toMatch(/403/);
  });

  it('refuses a download link that points anywhere but the releases page', async () => {
    const r = await checkForUpdates('0.1.0', reply(200, { ...release('v9.0.0'), html_url: 'https://example.com/tycho.dmg' }));
    expect(r).toMatchObject({ available: false, latest: null });
    expect(r.error).toBeTruthy();
  });
});
