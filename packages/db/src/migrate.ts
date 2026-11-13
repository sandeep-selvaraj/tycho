import type BetterSqlite3 from 'better-sqlite3';
import init001 from './migrations/001_init';
import titleRank002 from './migrations/002_title_rank';
import meta003 from './migrations/003_meta';
import activity004 from './migrations/004_activity';

/** Ordered list. Never edit a shipped migration; append a new one. */
export const MIGRATIONS: string[] = [init001, titleRank002, meta003, activity004];

export function migrate(db: BetterSqlite3.Database, migrations = MIGRATIONS): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return migrations.length;
}
