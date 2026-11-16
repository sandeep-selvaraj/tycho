import { useEffect, useState } from 'react';
import { useTycho } from './useQuery';
import { HARNESS, usd } from './format';
import { Overview, Sessions, Sources } from './views';
import { Transcript } from './Transcript';
import { ErrorBoundary } from './ErrorBoundary';
import { Tools } from './Tools';
import { Search } from './Search';
import { Costs } from './Costs';
import { Mark } from './Mark';
import { Wordmark } from './Wordmark';

const VIEWS = ['Overview', 'Sessions', 'Costs', 'Tools', 'Search', 'Sources'] as const;
type View = (typeof VIEWS)[number];

export function App() {
  const [view, setView] = useState<View>('Overview');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => window.tycho.onOpenSession(setOpenId), []);
  const go = (v: View) => {
    setOpenId(null);
    setView(v);
  };
  const { data: ov } = useTycho(() => window.tycho.overview());
  const { data: sources = [] } = useTycho(() => window.tycho.sources());
  const issues = sources.filter((s) => s.health !== 'ok').length;

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand"><Mark /><Wordmark /></div>
        <div className="readout" aria-label="API-equivalent cost">
          <div><b>{usd(ov?.costToday ?? 0)}</b><span>Today</span></div>
          <div><b>{usd(ov?.cost7d ?? 0)}</b><span>7 days</span></div>
          <div><b>{usd(ov?.cost30d ?? 0)}</b><span>30 days</span></div>
          <div className="live"><b>{ov?.liveCount ?? 0}</b><span>running</span></div>
        </div>
        <div className="note">API-equivalent cost</div>
      </header>

      <nav aria-label="Views">
        {VIEWS.map((v) => (
          <button key={v} aria-current={view === v && !openId} onClick={() => go(v)}>
            {v}
            {v === 'Sessions' && ov ? <small>{ov.sessionCount.toLocaleString()}</small> : null}
            {v === 'Sources' && issues > 0 ? <small className="err">{issues} issue{issues > 1 ? 's' : ''}</small> : null}
          </button>
        ))}
        <hr />
        <div className="legend">
          {Object.values(HARNESS).map((h) => (
            <span key={h.label}><i style={{ background: h.color }} />{h.label}</span>
          ))}
          <span style={{ marginTop: 8 }}><b>R</b> reported · <b>C</b> computed · <b>E</b> estimated</span>
        </div>
      </nav>

      <main>
        <section className="view on">
          <ErrorBoundary resetKey={`${view}:${openId}`}>
          {openId && <Transcript id={openId} onBack={() => setOpenId(null)} />}
          {!openId && view === 'Overview' && <Overview onOpen={setOpenId} />}
          {!openId && view === 'Sessions' && <Sessions onOpen={setOpenId} />}
          {!openId && view === 'Sources' && <Sources />}
          {/* Stays mounted behind an open session, so coming back lands on the same period. */}
          {view === 'Costs' && <div hidden={!!openId}><Costs onOpen={setOpenId} /></div>}
          {!openId && view === 'Tools' && <Tools />}
          {!openId && view === 'Search' && <Search onOpen={setOpenId} />}
          </ErrorBoundary>
        </section>
      </main>
    </div>
  );
}
