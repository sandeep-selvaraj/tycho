import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Settings } from '@tycho/core';

export const SettingsSchema = z.object({
  // Off unless the user turns it on: Tycho makes no network request it was not asked for.
  checkUpdatesOnLaunch: z.boolean().default(false),
});

/** Preferences live in a small JSON file next to the database. A missing or damaged file means defaults. */
export function loadSettings(file: string): Settings {
  try {
    return SettingsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return SettingsSchema.parse({});
  }
}

export function saveSettings(file: string, settings: Settings): Settings {
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}
