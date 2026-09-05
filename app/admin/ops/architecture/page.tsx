import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { ArrowLeft, Maximize2 } from 'lucide-react';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';

// Auth-gated, static content, always rendered dynamically (never cached at build).
// Deliberately imports NO database/service-role client — this page is pure copy +
// SVG, so there is nothing sensitive to leak even if auth ever regressed.
export const dynamic = 'force-dynamic';

// robots noindex/nofollow is inherited from app/admin/ops/layout.tsx (whole
// segment). We only pin an absolute title so it doesn't fall back to a template.
export const metadata: Metadata = {
  title: { absolute: 'Eilif · Ops Architecture' },
};

const REPO = 'https://github.com/cbspears/valheim-dashboard';
const FULLSCREEN = 'https://claude.ai/code/artifact/3182f247-c9bf-442a-bbf7-3163ea1e176d';

export default async function OpsArchitecturePage() {
  // ---- Auth gate (fail closed) — same check the cockpit uses -----------------
  const store = await cookies();
  if (!verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops/login');
  }

  return (
    <div className="space-y-6">
      {/* Cockpit-styled nav chrome (sits in the app's dark theme) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/admin/ops"
          className="inline-flex items-center gap-1.5 text-sm text-ash-dim transition hover:text-gold"
        >
          <ArrowLeft size={15} />
          Back to cockpit
        </Link>
        <a
          href={FULLSCREEN}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-rune bg-surface-raised px-3 py-1.5 text-xs font-medium text-ash-dim transition hover:border-gold-dim hover:text-ash"
        >
          <Maximize2 size={14} />
          Full-screen version
        </a>
      </div>

      {/* ================================================================== */}
      {/* Faithful reproduction of the standalone architecture reference.    */}
      {/* Self-contained + theme-aware: all styling lives in the scoped       */}
      {/* <style> below, every selector namespaced under .eilif-arch so it    */}
      {/* never touches the app chrome. Light/dark follow the artifact's own  */}
      {/* CSS custom properties (prefers-color-scheme + [data-theme]).        */}
      {/* ================================================================== */}
      <div className="eilif-arch overflow-hidden rounded-xl border border-rune">
        <div className="wrap">
          <header>
            <p className="eyebrow">Eilif · system architecture · 2026-07-12</p>
            <h1>How the whole Eilif system fits together</h1>
            <p className="dek">
              One modded Valheim server, a pack of client mods, four host-side services, a Next.js
              dashboard on Vercel, a Supabase database, a Discord bot, and an owner-only ops cockpit,
              all talking to each other. This map traces every hop: what talks to what, over which
              transport, with what auth. Boxes link into{' '}
              <strong>github.com/cbspears/valheim-dashboard</strong>. Start with the simple view,
              then follow the arrows into the detail and the walkthroughs.{' '}
              <a href={FULLSCREEN} target="_blank" rel="noreferrer">
                Open the full-screen version ↗
              </a>
            </p>
          </header>

          {/* ============ LEGEND ============ */}
          <div className="legend" aria-label="legend">
            <div className="grp">
              <h4>Zones (where code runs)</h4>
              <div className="lg-row">
                <span className="sw" style={{ background: 'var(--z-game-bg)', borderColor: 'var(--z-game)' }} /> Game &amp; player PCs
              </div>
              <div className="lg-row">
                <span className="sw" style={{ background: 'var(--z-host-bg)', borderColor: 'var(--z-host)' }} /> Host services (your PC · systemd)
              </div>
              <div className="lg-row">
                <span className="sw" style={{ background: 'var(--z-api-bg)', borderColor: 'var(--z-api)' }} /> Vercel · Next.js API
              </div>
            </div>
            <div className="grp">
              <h4>&nbsp;</h4>
              <div className="lg-row">
                <span className="sw" style={{ background: 'var(--z-db-bg)', borderColor: 'var(--z-db)' }} /> Supabase (Postgres + Storage)
              </div>
              <div className="lg-row">
                <span className="sw" style={{ background: 'var(--z-out-bg)', borderColor: 'var(--z-out)' }} /> Surfaces &amp; people
              </div>
            </div>
            <div className="grp">
              <h4>Arrows (how they talk)</h4>
              <div className="lg-row">
                <span className="eln" style={{ borderColor: 'var(--e-post)' }} /> HTTPS POST (authenticated)
              </div>
              <div className="lg-row">
                <span className="eln" style={{ borderColor: 'var(--e-sftp)' }} /> SFTP pull (files)
              </div>
              <div className="lg-row">
                <span className="eln" style={{ borderColor: 'var(--e-read)' }} /> DB read (anon / RLS)
              </div>
            </div>
            <div className="grp">
              <h4>&nbsp;</h4>
              <div className="lg-row">
                <span className="eln" style={{ borderColor: 'var(--e-write)' }} /> DB write (service role)
              </div>
              <div className="lg-row">
                <span className="eln" style={{ borderColor: 'var(--e-discord)' }} /> Discord gateway
              </div>
              <div className="lg-row">
                <span className="eln dash" style={{ borderColor: 'var(--e-poll)' }} /> Poll (pull on a timer)
              </div>
            </div>
          </div>

          {/* ============ SIMPLE VIEW ============ */}
          <h2 className="sec">The simple view</h2>
          <p className="sec-sub">
            Five stages, left to right. The game produces facts; those facts are ingested, stored
            once in Supabase, and then read back out by every surface people actually look at.
          </p>
          <div className="stage simple">
            <svg viewBox="0 0 1000 250" role="img" aria-label="Simple five-stage flow">
              <defs>
                <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--ink-faint)" />
                </marker>
              </defs>
              {/* stage boxes */}
              <g>
                <rect x="8" y="70" width="176" height="108" rx="12" fill="var(--z-game-bg)" stroke="var(--z-game)" />
                <text x="96" y="98" textAnchor="middle" className="n-title" fontSize="15" fill="var(--ink)">① The game</text>
                <text x="96" y="120" textAnchor="middle" className="n-sub" fontSize="11">Valheim server</text>
                <text x="96" y="136" textAnchor="middle" className="n-sub" fontSize="11">+ server &amp; client mods</text>
                <text x="96" y="158" textAnchor="middle" className="n-sub" fontSize="11">emits stats, deaths,</text>
                <text x="96" y="172" textAnchor="middle" className="n-sub" fontSize="11">positions, boss kills</text>
              </g>
              <g>
                <rect x="214" y="70" width="176" height="108" rx="12" fill="var(--z-api-bg)" stroke="var(--z-api)" />
                <text x="302" y="98" textAnchor="middle" className="n-title" fontSize="15" fill="var(--ink)">② Ingestion</text>
                <text x="302" y="120" textAnchor="middle" className="n-sub" fontSize="11">host services relay</text>
                <text x="302" y="136" textAnchor="middle" className="n-sub" fontSize="11">logs over SFTP →</text>
                <text x="302" y="158" textAnchor="middle" className="n-sub" fontSize="11">Vercel API routes</text>
                <text x="302" y="172" textAnchor="middle" className="n-sub" fontSize="11">validate &amp; authenticate</text>
              </g>
              <g>
                <rect x="420" y="70" width="160" height="108" rx="12" fill="var(--z-db-bg)" stroke="var(--z-db)" />
                <text x="500" y="98" textAnchor="middle" className="n-title" fontSize="15" fill="var(--ink)">③ Supabase</text>
                <text x="500" y="122" textAnchor="middle" className="n-sub" fontSize="11">the single shared</text>
                <text x="500" y="138" textAnchor="middle" className="n-sub" fontSize="11">source of truth</text>
                <text x="500" y="160" textAnchor="middle" className="n-sub" fontSize="11">Postgres + Storage</text>
              </g>
              <g>
                <rect x="610" y="40" width="176" height="72" rx="12" fill="var(--z-out-bg)" stroke="var(--z-out)" />
                <text x="698" y="66" textAnchor="middle" className="n-title" fontSize="14" fill="var(--ink)">④ Surfaces</text>
                <text x="698" y="86" textAnchor="middle" className="n-sub" fontSize="11">Dashboard · Discord</text>
                <text x="698" y="101" textAnchor="middle" className="n-sub" fontSize="11">Ops cockpit</text>
              </g>
              <g>
                <rect x="610" y="132" width="176" height="60" rx="12" fill="var(--surface-2)" stroke="var(--line)" />
                <text x="698" y="156" textAnchor="middle" className="n-title" fontSize="13" fill="var(--ink-soft)">the bot bridges</text>
                <text x="698" y="174" textAnchor="middle" className="n-sub" fontSize="11">Supabase ⇄ Discord</text>
              </g>
              <g>
                <rect x="816" y="70" width="176" height="108" rx="12" fill="var(--surface)" stroke="var(--line)" />
                <text x="904" y="98" textAnchor="middle" className="n-title" fontSize="15" fill="var(--ink)">⑤ People</text>
                <text x="904" y="122" textAnchor="middle" className="n-sub" fontSize="11">players see the site</text>
                <text x="904" y="138" textAnchor="middle" className="n-sub" fontSize="11">&amp; the Discord feed</text>
                <text x="904" y="160" textAnchor="middle" className="n-sub" fontSize="11">you watch the cockpit</text>
              </g>
              {/* arrows */}
              <g stroke="var(--ink-faint)" strokeWidth="2.4" fill="none" markerEnd="url(#ah)">
                <line x1="186" y1="124" x2="212" y2="124" />
                <line x1="392" y1="124" x2="418" y2="124" />
                <path d="M582,116 C596,100 598,90 608,80" />
                <path d="M582,140 C596,150 598,158 608,162" />
                <line x1="788" y1="76" x2="814" y2="100" />
              </g>
            </svg>
          </div>

          {/* ============ DETAILED VIEW ============ */}
          <h2 className="sec">The detailed view</h2>
          <p className="sec-sub">
            Every component and the principal flows between them, coloured by transport. Two flows
            deliberately run “backwards” and are covered in the walkthroughs: the server{' '}
            <em>polls</em> <code>/api/voice</code> for NPC lines, and the Discord bot both reads from
            and posts to Discord. Boxes are clickable, and they open the code on GitHub.
          </p>
          <div className="stage detail">
            <svg viewBox="0 0 1300 660" role="img" aria-label="Detailed architecture diagram">
              <defs>
                <marker id="m-post" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--e-post)" />
                </marker>
                <marker id="m-sftp" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--e-sftp)" />
                </marker>
                <marker id="m-write" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--e-write)" />
                </marker>
                <marker id="m-read" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--e-read)" />
                </marker>
                <marker id="m-discord" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--e-discord)" />
                </marker>
                <marker id="m-poll" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--e-poll)" />
                </marker>
              </defs>

              {/* zone bands + labels */}
              <g className="zband">
                <rect x="8" y="44" width="248" height="600" rx="10" fill="var(--z-game-bg)" />
                <rect x="286" y="44" width="224" height="600" rx="10" fill="var(--z-host-bg)" />
                <rect x="540" y="44" width="212" height="600" rx="10" fill="var(--z-api-bg)" />
                <rect x="782" y="44" width="216" height="600" rx="10" fill="var(--z-db-bg)" />
                <rect x="1028" y="44" width="264" height="600" rx="10" fill="var(--z-out-bg)" />
              </g>
              <g className="zlabel" fontSize="11" textAnchor="middle">
                <text x="132" y="32" fill="var(--z-game)">Game &amp; players</text>
                <text x="398" y="32" fill="var(--z-host)">Host services</text>
                <text x="646" y="32" fill="var(--z-api)">Vercel API</text>
                <text x="890" y="32" fill="var(--z-db)">Supabase</text>
                <text x="1160" y="32" fill="var(--z-out)">Surfaces &amp; people</text>
              </g>

              {/* ===== ARROWS (under the cards) ===== */}
              {/* Direct HTTPS POST highway (mods -> gs-ingest), routed along the top */}
              <g fill="none" stroke="var(--e-post)" strokeWidth="2.3">
                <path d="M132,88 C132,58 400,58 610,58 L610,86" markerEnd="url(#m-post)" />
                <path d="M240,300 C240,64 470,66 616,66 L616,88" markerEnd="url(#m-post)" opacity=".9" />
              </g>
              <text x="360" y="52" className="e-label" fontSize="10" fill="var(--e-post)" textAnchor="middle">direct HTTPS POST · mods → /api/gs-ingest (Bearer / no-secret)</text>

              {/* SFTP: server files -> host services */}
              <g fill="none" stroke="var(--e-sftp)" strokeWidth="2.3">
                <path d="M256,150 C270,150 276,96 286,96" markerEnd="url(#m-sftp)" />
                <path d="M256,188 C270,188 276,276 286,276" markerEnd="url(#m-sftp)" />
              </g>
              <text x="270" y="128" className="e-label" fontSize="9.5" fill="var(--e-sftp)" textAnchor="middle">SFTP</text>

              {/* host services -> API (authed POST) */}
              <g fill="none" stroke="var(--e-post)" strokeWidth="2.3">
                <path d="M510,96 C525,96 528,182 540,182" markerEnd="url(#m-post)" />
              </g>
              <text x="527" y="150" className="e-label" fontSize="9.5" fill="var(--e-post)" textAnchor="middle">x-webhook-secret</text>
              {/* producers -> ops heartbeat */}
              <path d="M510,300 C524,340 528,392 540,392" fill="none" stroke="var(--e-post)" strokeWidth="2.1" markerEnd="url(#m-post)" />
              <text x="528" y="360" className="e-label" fontSize="9.5" fill="var(--e-post)" textAnchor="middle">heartbeat · Bearer</text>

              {/* API -> Supabase (service-role write) */}
              <g fill="none" stroke="var(--e-write)" strokeWidth="2.3">
                <path d="M732,108 C760,108 764,150 782,150" markerEnd="url(#m-write)" />
                <path d="M732,190 C758,190 764,180 782,180" markerEnd="url(#m-write)" />
                <path d="M726,392 C760,392 766,300 782,290" markerEnd="url(#m-write)" />
              </g>
              <text x="762" y="132" className="e-label" fontSize="9.5" fill="var(--e-write)" textAnchor="middle">service role</text>

              {/* map snapshot -> storage (bottom highway) */}
              <path d="M396,300 C396,470 700,470 890,470 L890,408" fill="none" stroke="var(--e-write)" strokeWidth="2.2" markerEnd="url(#m-write)" />
              <text x="620" y="484" className="e-label" fontSize="9.5" fill="var(--e-write)" textAnchor="middle">fog-masked map frames → Storage (service role)</text>

              {/* voice poll (server -> /api/voice) dashed, bottom */}
              <path d="M132,300 C132,520 360,520 590,520 L610,340" fill="none" stroke="var(--e-poll)" strokeWidth="2" strokeDasharray="6 5" markerEnd="url(#m-poll)" />
              <text x="360" y="536" className="e-label" fontSize="9.5" fill="var(--e-poll)" textAnchor="middle">server polls /api/voice for NPC lines (x-voice-token)</text>

              {/* Supabase -> Dashboard / Cockpit (reads) */}
              <path d="M998,150 C1015,150 1020,104 1028,104" fill="none" stroke="var(--e-read)" strokeWidth="2.3" markerEnd="url(#m-read)" />
              <text x="1016" y="130" className="e-label" fontSize="9.5" fill="var(--e-read)" textAnchor="middle">anon · RLS</text>
              <path d="M998,220 C1015,220 1020,224 1028,224" fill="none" stroke="var(--e-write)" strokeWidth="2.3" markerEnd="url(#m-read)" />
              <text x="1016" y="246" className="e-label" fontSize="9.5" fill="var(--e-write)" textAnchor="middle">service role</text>

              {/* bot <-> Discord (the bridge) */}
              <path d="M510,360 C900,600 1040,420 1120,368" fill="none" stroke="var(--e-discord)" strokeWidth="2.2" markerEnd="url(#m-discord)" />
              <text x="880" y="592" className="e-label" fontSize="9.5" fill="var(--e-discord)" textAnchor="middle">bot ⇄ Discord (posts feed / @everyone · reads gallery &amp; @Eilif commands)</text>

              {/* ===== CARDS ===== */}
              {/* Zone A */}
              <a className="node" href={`${REPO}/tree/main/plugins/eilif-companion`} target="_blank" rel="noreferrer">
                <rect x="20" y="60" width="224" height="176" rx="9" fill="var(--surface)" stroke="var(--z-game)" />
                <text x="34" y="82" className="n-title" fontSize="13" fill="var(--ink)">🖥 Valheim Server (GTX)</text>
                <text x="34" y="102" className="n-sub" fontSize="11">Eilif Companion (server mod)</text>
                <text x="34" y="118" className="n-sub" fontSize="11">GsValheimStats Emitter ·3rd-party</text>
                <text x="34" y="134" className="n-sub" fontSize="11">WebMap · ValheimPlus</text>
                <text x="34" y="158" className="n-sub" fontSize="10.5" fill="var(--z-game)">emits → server payloads (roster,</text>
                <text x="34" y="172" className="n-sub" fontSize="10.5" fill="var(--z-game)">worldDay, boss milestones)</text>
                <text x="34" y="192" className="n-sub" fontSize="10.5">writes LogOutput.log</text>
                <text x="34" y="212" className="n-sub" fontSize="10.5">serves WebMap map.png / fog.png</text>
                <text x="34" y="228" className="e-label" fontSize="9" fill="var(--z-game)">plugins/eilif-companion ↗</text>
              </a>
              <a className="node" href={`${REPO}/tree/main/plugins/eilif-companion-client`} target="_blank" rel="noreferrer">
                <rect x="20" y="266" width="224" height="132" rx="9" fill="var(--surface)" stroke="var(--z-game)" />
                <text x="34" y="288" className="n-title" fontSize="13" fill="var(--ink)">💻 Player PCs · r2modman pack</text>
                <text x="34" y="308" className="n-sub" fontSize="11">GsValheimStatsClient ·3rd-party</text>
                <text x="34" y="324" className="n-sub" fontSize="11">EilifCompanionClient (map %)</text>
                <text x="34" y="340" className="n-sub" fontSize="11">EilifPaths (roads)</text>
                <text x="34" y="362" className="n-sub" fontSize="10.5" fill="var(--z-game)">each client POSTs its own stats,</text>
                <text x="34" y="376" className="n-sub" fontSize="10.5" fill="var(--z-game)">deaths &amp; map% (source:client)</text>
                <text x="34" y="392" className="e-label" fontSize="9" fill="var(--z-game)">plugins/eilif-companion-client ↗</text>
              </a>

              {/* Zone B */}
              <a className="node" href={`${REPO}/tree/main/services/log-poller`} target="_blank" rel="noreferrer">
                <rect x="292" y="62" width="212" height="70" rx="9" fill="var(--surface)" stroke="var(--z-host)" />
                <text x="304" y="84" className="n-title" fontSize="12.5" fill="var(--ink)">Log poller</text>
                <text x="304" y="102" className="n-sub" fontSize="10.5">tails LogOutput.log → parses</text>
                <text x="304" y="117" className="n-sub" fontSize="10.5">joins/deaths/oaths/pins/chat</text>
                <text x="304" y="128" className="e-label" fontSize="9" fill="var(--z-host)">services/log-poller ↗</text>
              </a>
              {/* The stats-parser node stood here. eilif-stats-parser.service was
                  retired 2026-08-23 and its webhook branch with it; player_stats is fed
                  end to end by the Emitter and the Companion Client now, so drawing it
                  claimed a producer that has not written a row in weeks. */}
              <a className="node" href={`${REPO}/blob/main/scripts/map-snapshot.mjs`} target="_blank" rel="noreferrer">
                <rect x="292" y="224" width="212" height="56" rx="9" fill="var(--surface)" stroke="var(--z-host)" />
                <text x="304" y="246" className="n-title" fontSize="12.5" fill="var(--ink)">Map snapshot</text>
                <text x="304" y="264" className="n-sub" fontSize="10.5">fog-masks frames → Storage</text>
                <text x="304" y="275" className="e-label" fontSize="9" fill="var(--z-host)">scripts/map-snapshot.mjs ↗</text>
              </a>
              <a className="node" href={`${REPO}/tree/main/services/discord-bot`} target="_blank" rel="noreferrer">
                <rect x="292" y="298" width="212" height="110" rx="9" fill="var(--surface)" stroke="var(--z-host)" />
                <text x="304" y="320" className="n-title" fontSize="12.5" fill="var(--ink)">Discord bot</text>
                <text x="304" y="338" className="n-sub" fontSize="10.5">polls events → posts feed;</text>
                <text x="304" y="353" className="n-sub" fontSize="10.5">recaps · milestones · titles;</text>
                <text x="304" y="368" className="n-sub" fontSize="10.5">gallery · identity · voice queue</text>
                <text x="304" y="386" className="n-sub" fontSize="10.5">events-sync every 10 min</text>
                <text x="304" y="401" className="e-label" fontSize="9" fill="var(--z-host)">services/discord-bot ↗</text>
              </a>

              {/* Zone C */}
              <a className="node" href={`${REPO}/blob/main/app/api/gs-ingest/route.ts`} target="_blank" rel="noreferrer">
                <rect x="546" y="86" width="200" height="66" rx="9" fill="var(--surface)" stroke="var(--z-api)" />
                <text x="558" y="108" className="n-title" fontSize="12.5" fill="var(--ink)">/api/gs-ingest</text>
                <text x="558" y="126" className="n-sub" fontSize="10.5">mod stats · deaths · boss kills</text>
                <text x="558" y="140" className="n-sub" fontSize="10">server→Bearer · client→validated</text>
                <text x="558" y="150" className="e-label" fontSize="8.5" fill="var(--z-api)">app/api/gs-ingest ↗</text>
              </a>
              <a className="node" href={`${REPO}/blob/main/app/api/webhook/route.ts`} target="_blank" rel="noreferrer">
                <rect x="546" y="166" width="200" height="58" rx="9" fill="var(--surface)" stroke="var(--z-api)" />
                <text x="558" y="188" className="n-title" fontSize="12.5" fill="var(--ink)">/api/webhook</text>
                <text x="558" y="206" className="n-sub" fontSize="10.5">poller events · stats · oath-link</text>
                <text x="558" y="219" className="e-label" fontSize="8.5" fill="var(--z-api)">app/api/webhook ↗</text>
              </a>
              <a className="node" href={`${REPO}/blob/main/app/api/voice/route.ts`} target="_blank" rel="noreferrer">
                <rect x="546" y="286" width="200" height="52" rx="9" fill="var(--surface)" stroke="var(--z-api)" />
                <text x="558" y="308" className="n-title" fontSize="12.5" fill="var(--ink)">/api/voice</text>
                <text x="558" y="325" className="n-sub" fontSize="10.5">NPC line queue (polled)</text>
                <text x="558" y="334" className="e-label" fontSize="8.5" fill="var(--z-api)">app/api/voice ↗</text>
              </a>
              <a className="node" href={`${REPO}/tree/main/app/api/ops`} target="_blank" rel="noreferrer">
                <rect x="546" y="366" width="200" height="52" rx="9" fill="var(--surface)" stroke="var(--z-api)" />
                <text x="558" y="388" className="n-title" fontSize="12.5" fill="var(--ink)">/api/ops/*</text>
                <text x="558" y="405" className="n-sub" fontSize="10.5">heartbeat (Bearer) · login</text>
                <text x="558" y="414" className="e-label" fontSize="8.5" fill="var(--z-api)">app/api/ops ↗</text>
              </a>

              {/* Zone D */}
              <a className="node" href={`${REPO}/tree/main/db`} target="_blank" rel="noreferrer">
                <rect x="788" y="90" width="204" height="204" rx="9" fill="var(--surface)" stroke="var(--z-db)" />
                <text x="800" y="112" className="n-title" fontSize="12.5" fill="var(--ink)">Postgres (RLS)</text>
                <text x="800" y="132" className="n-sub" fontSize="10.5">players · sessions · events</text>
                <text x="800" y="147" className="n-sub" fontSize="10.5">player_stats · bosses</text>
                <text x="800" y="162" className="n-sub" fontSize="10.5">server_status · oaths · pins</text>
                <text x="800" y="177" className="n-sub" fontSize="10.5">voice_lines · milestones</text>
                <text x="800" y="192" className="n-sub" fontSize="10.5">gallery_photos · discord_events</text>
                <text x="800" y="210" className="n-sub" fontSize="10.5" fill="var(--z-db)">service-role only:</text>
                <text x="800" y="225" className="n-sub" fontSize="10.5">player_positions · chat_lines</text>
                <text x="800" y="240" className="n-sub" fontSize="10.5">identity_claims · ops_heartbeats</text>
                <text x="800" y="262" className="n-sub" fontSize="10">public-read via anon; writes via</text>
                <text x="800" y="276" className="n-sub" fontSize="10">service role (server-side only)</text>
                <text x="800" y="290" className="e-label" fontSize="9" fill="var(--z-db)">db/*.sql ↗</text>
              </a>
              <rect x="788" y="352" width="204" height="56" rx="9" fill="var(--surface)" stroke="var(--z-db)" />
              <text x="800" y="374" className="n-title" fontSize="12.5" fill="var(--ink)">Storage (buckets)</text>
              <text x="800" y="392" className="n-sub" fontSize="10.5">gallery images · map frames</text>

              {/* Zone E */}
              <a className="node" href={`${REPO}/blob/main/lib/data.ts`} target="_blank" rel="noreferrer">
                <rect x="1034" y="72" width="252" height="80" rx="9" fill="var(--surface)" stroke="var(--z-out)" />
                <text x="1046" y="94" className="n-title" fontSize="12.5" fill="var(--ink)">Public Dashboard · Vercel SSR</text>
                <text x="1046" y="112" className="n-sub" fontSize="10.5">Hall · Vikings · World · Saga</text>
                <text x="1046" y="127" className="n-sub" fontSize="10.5">Map · Gallery · Oath · /viking · /tv</text>
                <text x="1046" y="145" className="e-label" fontSize="9" fill="var(--z-out)">app/ · lib/data.ts ↗</text>
              </a>
              <a className="node" href={`${REPO}/blob/main/app/admin/ops/page.tsx`} target="_blank" rel="noreferrer">
                <rect x="1034" y="192" width="252" height="66" rx="9" fill="var(--surface)" stroke="var(--z-out)" />
                <text x="1046" y="214" className="n-title" fontSize="12.5" fill="var(--ink)">Ops Cockpit · /admin/ops</text>
                <text x="1046" y="232" className="n-sub" fontSize="10.5">owner-only · reads service role</text>
                <text x="1046" y="246" className="n-sub" fontSize="10.5">health from ops_heartbeats</text>
                <text x="1046" y="256" className="e-label" fontSize="8.5" fill="var(--z-out)">app/admin/ops ↗</text>
              </a>
              <rect x="1034" y="322" width="252" height="60" rx="9" fill="var(--surface)" stroke="var(--z-out)" />
              <text x="1046" y="344" className="n-title" fontSize="12.5" fill="var(--ink)">Discord</text>
              <text x="1046" y="362" className="n-sub" fontSize="10.5">#server (feed) · #valheim (@everyone)</text>
              <text x="1046" y="376" className="n-sub" fontSize="10.5">gallery channel · bot DMs</text>
              <rect x="1034" y="404" width="252" height="48" rx="9" fill="var(--surface)" stroke="var(--line)" />
              <text x="1046" y="426" className="n-title" fontSize="12" fill="var(--ink-soft)">Players&apos; browsers</text>
              <text x="1046" y="443" className="n-sub" fontSize="10.5">read the public site (server-rendered)</text>
            </svg>
          </div>

          {/* ============ WALKTHROUGHS ============ */}
          <h2 className="sec">Follow the data: four journeys</h2>
          <p className="sec-sub">
            The arrows make more sense once you trace a single thing end to end. Here are the four
            flows that cover almost the whole system.
          </p>
          <div className="flows">
            <div className="flow f-game">
              <h3>⚔ A boss falls</h3>
              <p className="goal">In-game kill → mass ping + permanent site update</p>
              <ol>
                <li>A player lands the killing blow in-game.</li>
                <li>
                  The server-side <b>GsValheimStats Emitter</b> POSTs a <code>source:&apos;server&apos;</code>{' '}
                  payload with the <code>defeated_*</code> milestone to <code>/api/gs-ingest</code>,
                  authenticated with <b>Bearer <code>GS_EMITTER_TOKEN</code></b>.
                </li>
                <li>
                  The route flips the <code>bosses</code> row <code>is_killed=true</code> and inserts
                  a boss <code>event</code>, a one-way latch written with the <b>service role</b>.
                </li>
                <li>
                  The <b>Discord bot</b> (polling Supabase) sees the felled boss and posts an{' '}
                  <b>@everyone</b> to <code>#valheim</code>.
                </li>
                <li>
                  Players loading <b>/world</b> and <b>/boss/[slug]</b> read the flipped row (anon +
                  RLS) and see the war-room update.
                </li>
              </ol>
            </div>
            <div className="flow f-host">
              <h3>📜 A viking swears in &amp; links identity</h3>
              <p className="goal">Discord + in-game shout → bound account</p>
              <ol>
                <li>
                  In Discord: <code>@Eilif I am Bjorn</code>. The <b>bot</b> mints a one-time code
                  into <code>identity_claims</code> and <b>DMs it privately</b>.
                </li>
                <li>
                  In-game, the player shouts <code>/oath &lt;code&gt; — my vow</code>. The server
                  echoes it to <b>LogOutput.log</b>.
                </li>
                <li>
                  The <b>log poller</b> tails the log over <b>SFTP</b>, parses the{' '}
                  <code>[EILIF_OATH]</code> marker, and POSTs it to <code>/api/webhook</code>{' '}
                  (<code>x-webhook-secret</code>).
                </li>
                <li>
                  The webhook <b>atomically consumes the code</b>, links{' '}
                  <code>players.discord_user_id</code> to whichever viking actually shouted it, and
                  stores the oath.
                </li>
                <li>The bot DMs a confirmation; the oath appears on <b>/oath</b>.</li>
              </ol>
            </div>
            <div className="flow f-out">
              <h3>🌐 A player opens the site</h3>
              <p className="goal">Browser → what&apos;s live right now</p>
              <ol>
                <li>
                  A browser requests a page from <b>Vercel</b>; it renders server-side (no client DB
                  access).
                </li>
                <li>
                  <b><code>lib/data.ts</code></b> reads Supabase with the <b>anon key</b>, filtered by{' '}
                  <b>RLS</b>, so only public columns/rows come back (never <code>steam_id</code>,
                  positions, or private chat).
                </li>
                <li>
                  “Who&apos;s online” and world-day come from <code>server_status</code>, kept fresh by
                  the Emitter&apos;s 120-s posts.
                </li>
                <li>Map frames + gallery images load from <b>Supabase Storage</b>.</li>
                <li>The finished HTML ships to the browser: fast, and with no secrets in it.</li>
              </ol>
            </div>
            <div className="flow f-db">
              <h3>🛡 You check the cockpit</h3>
              <p className="goal">Are all the moving parts alive?</p>
              <ol>
                <li>
                  The <b>bot, poller &amp; map-snapshot</b> each POST a heartbeat to{' '}
                  <code>/api/ops/heartbeat</code> (<b>Bearer <code>OPS_HEARTBEAT_TOKEN</code></b>) on
                  every loop.
                </li>
                <li>
                  That route redacts + upserts one row per component into <code>ops_heartbeats</code>.
                </li>
                <li>
                  You open <b>/admin/ops</b> and log in, and <code>OPS_PASSWORD</code> sets an
                  HMAC-signed <b>HttpOnly cookie</b>.
                </li>
                <li>
                  The page reads Supabase with a <b>server-only service-role client</b> and runs the
                  pure health + consistency checks.
                </li>
                <li>
                  The Emitter (which can&apos;t heartbeat) is <b>inferred</b> from{' '}
                  <code>server_status</code> freshness; anything with no signal shows <b>unknown</b>,
                  never fake-healthy.
                </li>
              </ol>
            </div>
          </div>

          {/* ============ COMPONENT INDEX ============ */}
          <h2 className="sec">Component index</h2>
          <p className="sec-sub">
            Every moving part, what it does, and who it talks to. Component names link to the code on
            GitHub.
          </p>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Zone</th>
                  <th>What it does</th>
                  <th>Talks to</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/plugins/eilif-companion`} target="_blank" rel="noreferrer">eilif-companion</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-game)' }} />
                    <span className="ztag">game</span>
                  </td>
                  <td>
                    Server BepInEx mod: captures <code>/oath</code>+<code>/pin</code> to the log,
                    speaks NPC lines, emits <code>[EILIF_POS]</code>.
                  </td>
                  <td>writes LogOutput.log; polls <code>/api/voice</code></td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/plugins/eilif-companion-client`} target="_blank" rel="noreferrer">eilif-companion-client</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-game)' }} />
                    <span className="ztag">game</span>
                  </td>
                  <td>Client mod (in the pack): posts each player&apos;s explored-map %.</td>
                  <td>→ <code>/api/gs-ingest</code> (client-map)</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/plugins/eilif-paths`} target="_blank" rel="noreferrer">eilif-paths</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-game)' }} />
                    <span className="ztag">game</span>
                  </td>
                  <td>Client roads/paths mod (gameplay only).</td>
                  <td>—</td>
                </tr>
                <tr>
                  <td className="comp">GsValheimStats</td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-game)' }} />
                    <span className="ztag">game·3P</span>
                  </td>
                  <td>
                    Third-party emitter (server) + client: roster, world-day, boss kills, per-player
                    stats, deaths.
                  </td>
                  <td>→ <code>/api/gs-ingest</code></td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/services/log-poller`} target="_blank" rel="noreferrer">log-poller</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-host)' }} />
                    <span className="ztag">host</span>
                  </td>
                  <td>
                    Tails the server log over SFTP; derives presence/sessions/deaths/oaths/pins/chat.
                  </td>
                  <td>
                    SFTP ← server; → <code>/api/webhook</code>; → Discord; →{' '}
                    <code>/api/ops/heartbeat</code>
                  </td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/blob/main/scripts/map-snapshot.mjs`} target="_blank" rel="noreferrer">map-snapshot</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-host)' }} />
                    <span className="ztag">host</span>
                  </td>
                  <td>Pulls WebMap tiles over SFTP; writes fog-masked frames + manifest.</td>
                  <td>SFTP ← server; → Storage; → <code>/api/ops/heartbeat</code></td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/services/discord-bot`} target="_blank" rel="noreferrer">discord-bot</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-host)' }} />
                    <span className="ztag">host</span>
                  </td>
                  <td>
                    Relays feed/recaps/milestones/titles; gallery + identity + voice-queue; events
                    sync.
                  </td>
                  <td>Supabase ⇄; Discord ⇄; → <code>/api/ops/heartbeat</code></td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/blob/main/app/api/gs-ingest/route.ts`} target="_blank" rel="noreferrer">/api/gs-ingest</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-api)' }} />
                    <span className="ztag">api</span>
                  </td>
                  <td>
                    The mod ingest. Server payloads need <code>GS_EMITTER_TOKEN</code>; client
                    payloads are validated (own-deaths-only, no ghost vikings).
                  </td>
                  <td>← mods; → Postgres (service role)</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/blob/main/app/api/webhook/route.ts`} target="_blank" rel="noreferrer">/api/webhook</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-api)' }} />
                    <span className="ztag">api</span>
                  </td>
                  <td>
                    Poller/stats events; also the single place an oath code is consumed &amp; identity
                    linked.
                  </td>
                  <td>← host services; → Postgres</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/blob/main/app/api/voice/route.ts`} target="_blank" rel="noreferrer">/api/voice</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-api)' }} />
                    <span className="ztag">api</span>
                  </td>
                  <td>Hands out queued NPC voice lines (claim-once).</td>
                  <td>← server poll (<code>x-voice-token</code>); ← Postgres</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/app/api/ops`} target="_blank" rel="noreferrer">/api/ops/*</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-api)' }} />
                    <span className="ztag">api</span>
                  </td>
                  <td>Cockpit heartbeat ingest (Bearer) + login/logout (cookie).</td>
                  <td>← producers; → Postgres</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/tree/main/db`} target="_blank" rel="noreferrer">Supabase</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-db)' }} />
                    <span className="ztag">db</span>
                  </td>
                  <td>
                    Postgres (public-read RLS + service-role-only tables) &amp; Storage. The one
                    shared state.
                  </td>
                  <td>← API + bot (write); → dashboard/cockpit (read)</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/blob/main/lib/data.ts`} target="_blank" rel="noreferrer">Public dashboard</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-out)' }} />
                    <span className="ztag">out</span>
                  </td>
                  <td>Server-rendered pages (Hall, Vikings, World, Map, Oath, /viking, /tv…).</td>
                  <td>← Postgres (anon/RLS) + Storage; → browsers</td>
                </tr>
                <tr>
                  <td className="comp">
                    <a href={`${REPO}/blob/main/app/admin/ops/page.tsx`} target="_blank" rel="noreferrer">/admin/ops cockpit</a>
                  </td>
                  <td>
                    <span className="zdot" style={{ background: 'var(--z-out)' }} />
                    <span className="ztag">out</span>
                  </td>
                  <td>
                    Owner-only health dashboard; login-gated, reads service role, observational only.
                  </td>
                  <td>← Postgres (service role) + ops_heartbeats</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="note">
            <h3>The one idea that ties it together</h3>
            <p>
              Every arrow points, eventually, at <b>Supabase</b>. Nothing talks to anything else
              directly. The game emits, the services and API routes write, and every surface reads
              back from the same database. That&apos;s why the whole thing is loosely coupled and why
              the <b>trust boundary</b> sits at the ingest routes: anything a player&apos;s machine can
              send (mod payloads, in-game chat) is untrusted until an authenticated, validated route
              has vetted it. The security pass hardened exactly that seam; the cockpit watches
              whether every producer on the left is still feeding it.
            </p>
          </div>

          <footer>
            Eilif system architecture · repo github.com/cbspears/valheim-dashboard (main) · diagram
            reflects prod @ 7f62185.
            <br />
            Simplified for legibility: minor endpoints (/api/status, /api/titles) and back-flows
            (voice poll, bot⇄Discord) are described in the walkthroughs rather than drawn as separate
            arrows.
          </footer>
        </div>

        <style>{`
          .eilif-arch {
            --bg:#f3f5f7; --bg-sunk:#e8ecf0; --surface:#ffffff; --surface-2:#f7f9fb;
            --ink:#161c22; --ink-soft:#47535f; --ink-faint:#6b7885; --line:#d8dee5; --line-soft:#e6ebf0;
            --gold:#9a6f14; --gold-bg:#f7edd4;
            --z-game:#2f7d46;   --z-game-bg:#e3f0e7;
            --z-host:#2f6ab0;   --z-host-bg:#e4edf9;
            --z-api:#b5610f;    --z-api-bg:#fbecda;
            --z-db:#0f766e;     --z-db-bg:#d9efec;
            --z-out:#7c3aed;    --z-out-bg:#ece5fb;
            --e-sftp:#c07a12; --e-post:#2f7d46; --e-read:#2f6ab0; --e-discord:#7c3aed; --e-write:#7c8794; --e-poll:#9a6f14;
            --shadow:0 1px 2px rgba(20,30,40,.05), 0 4px 16px rgba(20,30,40,.05);
            --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
            --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
            --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
          }
          @media (prefers-color-scheme:dark){.eilif-arch{
            --bg:#0e1216; --bg-sunk:#090c0f; --surface:#161c22; --surface-2:#1b2229;
            --ink:#e7edf2; --ink-soft:#a9b6c2; --ink-faint:#7c8b98; --line:#29323b; --line-soft:#212a32;
            --gold:#d9a441; --gold-bg:#2a2413;
            --z-game:#5bbd7c; --z-game-bg:#13251a; --z-host:#5fa0e8; --z-host-bg:#12212f;
            --z-api:#e0913f; --z-api-bg:#2a1f11; --z-db:#3fb8ab; --z-db-bg:#0f2422; --z-out:#a98bf0; --z-out-bg:#1c1630;
            --e-sftp:#e0913f; --e-post:#5bbd7c; --e-read:#5fa0e8; --e-discord:#a98bf0; --e-write:#8a97a4; --e-poll:#d9a441;
            --shadow:0 1px 2px rgba(0,0,0,.3), 0 6px 20px rgba(0,0,0,.35);
          }}
          :root[data-theme="light"] .eilif-arch{--bg:#f3f5f7;--bg-sunk:#e8ecf0;--surface:#fff;--surface-2:#f7f9fb;--ink:#161c22;--ink-soft:#47535f;--ink-faint:#6b7885;--line:#d8dee5;--line-soft:#e6ebf0;--gold:#9a6f14;--gold-bg:#f7edd4;--z-game:#2f7d46;--z-game-bg:#e3f0e7;--z-host:#2f6ab0;--z-host-bg:#e4edf9;--z-api:#b5610f;--z-api-bg:#fbecda;--z-db:#0f766e;--z-db-bg:#d9efec;--z-out:#7c3aed;--z-out-bg:#ece5fb;--e-sftp:#c07a12;--e-post:#2f7d46;--e-read:#2f6ab0;--e-discord:#7c3aed;--e-write:#7c8794;--e-poll:#9a6f14;}
          :root[data-theme="dark"] .eilif-arch{--bg:#0e1216;--bg-sunk:#090c0f;--surface:#161c22;--surface-2:#1b2229;--ink:#e7edf2;--ink-soft:#a9b6c2;--ink-faint:#7c8b98;--line:#29323b;--line-soft:#212a32;--gold:#d9a441;--gold-bg:#2a2413;--z-game:#5bbd7c;--z-game-bg:#13251a;--z-host:#5fa0e8;--z-host-bg:#12212f;--z-api:#e0913f;--z-api-bg:#2a1f11;--z-db:#3fb8ab;--z-db-bg:#0f2422;--z-out:#a98bf0;--z-out-bg:#1c1630;--e-sftp:#e0913f;--e-post:#5bbd7c;--e-read:#5fa0e8;--e-discord:#a98bf0;--e-write:#8a97a4;--e-poll:#d9a441;}

          .eilif-arch *{box-sizing:border-box}
          .eilif-arch{background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
          .eilif-arch a{color:inherit}

          .eilif-arch .wrap{max-width:1120px;margin:0 auto;padding:clamp(20px,4vw,52px) clamp(14px,3.5vw,36px) 96px}

          .eilif-arch .eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-weight:600;margin:0 0 12px}
          .eilif-arch h1{font-family:var(--serif);font-weight:600;font-size:clamp(28px,5vw,44px);line-height:1.05;letter-spacing:-.01em;margin:0 0 14px;text-wrap:balance}
          .eilif-arch .dek{font-size:clamp(15px,2vw,17px);color:var(--ink-soft);max-width:70ch;margin:0}
          .eilif-arch .dek strong{color:var(--ink);font-weight:600}
          .eilif-arch h2.sec{font-family:var(--serif);font-size:clamp(21px,3vw,27px);font-weight:600;margin:52px 0 6px;letter-spacing:-.01em}
          .eilif-arch .sec-sub{color:var(--ink-soft);font-size:14.5px;margin:0 0 20px;max-width:74ch}
          .eilif-arch .repo{font-family:var(--mono);font-size:13px}

          /* legend */
          .eilif-arch .legend{display:flex;flex-wrap:wrap;gap:20px;margin:22px 0 4px;padding:16px 18px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
          .eilif-arch .legend .grp{display:flex;flex-direction:column;gap:8px;min-width:180px}
          .eilif-arch .legend .grp h4{margin:0 0 2px;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);font-weight:700}
          .eilif-arch .lg-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-soft)}
          .eilif-arch .sw{width:14px;height:14px;border-radius:4px;flex:none;border:1px solid rgba(0,0,0,.15)}
          .eilif-arch .eln{width:26px;height:0;border-top:3px solid;flex:none}
          .eilif-arch .eln.dash{border-top-style:dashed}

          /* svg stage */
          .eilif-arch .stage{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:8px;overflow-x:auto}
          .eilif-arch .stage svg{display:block;height:auto}
          .eilif-arch .stage.simple svg{width:100%;min-width:640px}
          .eilif-arch .stage.detail svg{width:100%;min-width:1000px}
          .eilif-arch svg text{font-family:var(--sans)}
          .eilif-arch .n-title{font-weight:700}
          .eilif-arch .n-sub{fill:var(--ink-faint)}
          .eilif-arch .e-label{font-family:var(--mono);font-weight:600}
          .eilif-arch .zband{opacity:.5}
          .eilif-arch .zlabel{font-family:var(--mono);font-weight:700;letter-spacing:.12em;text-transform:uppercase}
          .eilif-arch a.node{cursor:pointer}
          .eilif-arch a.node:hover rect{stroke-width:2.5}

          /* walkthroughs */
          .eilif-arch .flows{display:grid;gap:16px;margin-top:8px}
          @media(min-width:760px){.eilif-arch .flows{grid-template-columns:1fr 1fr}}
          .eilif-arch .flow{background:var(--surface);border:1px solid var(--line);border-left-width:4px;border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
          .eilif-arch .flow h3{margin:0 0 3px;font-size:16px;font-weight:650}
          .eilif-arch .flow .goal{font-size:12.5px;color:var(--ink-faint);margin:0 0 12px}
          .eilif-arch .flow ol{margin:0;padding:0;list-style:none;counter-reset:s;display:flex;flex-direction:column;gap:9px}
          .eilif-arch .flow li{counter-increment:s;position:relative;padding-left:30px;font-size:13.3px;color:var(--ink-soft)}
          .eilif-arch .flow li::before{content:counter(s);position:absolute;left:0;top:0;width:20px;height:20px;border-radius:6px;font-family:var(--mono);font-size:11px;font-weight:700;display:grid;place-items:center;background:var(--gold-bg);color:var(--gold)}
          .eilif-arch .flow li b{color:var(--ink);font-weight:600}
          .eilif-arch .flow code,.eilif-arch .tbl code,.eilif-arch .dek code,.eilif-arch .sec-sub code{font-family:var(--mono);font-size:.86em;background:var(--surface-2);border:1px solid var(--line-soft);padding:.5px 5px;border-radius:4px;color:var(--ink)}
          .eilif-arch .flow.f-game{border-left-color:var(--z-game)}
          .eilif-arch .flow.f-out{border-left-color:var(--z-out)}
          .eilif-arch .flow.f-host{border-left-color:var(--z-host)}
          .eilif-arch .flow.f-db{border-left-color:var(--z-db)}

          /* component index */
          .eilif-arch .tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);background:var(--surface)}
          .eilif-arch table{border-collapse:collapse;width:100%;min-width:640px;font-size:13.2px}
          .eilif-arch thead th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);font-weight:700;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--surface-2)}
          .eilif-arch tbody td{padding:10px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top;color:var(--ink-soft)}
          .eilif-arch tbody tr:last-child td{border-bottom:none}
          .eilif-arch td.comp{white-space:nowrap}
          .eilif-arch td.comp a{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--gold)}
          .eilif-arch td.comp a:hover{color:var(--gold)}
          .eilif-arch .zdot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:7px;vertical-align:middle}
          .eilif-arch .ztag{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint)}

          .eilif-arch .note{margin-top:44px;background:var(--gold-bg);border:1px solid var(--gold);border-radius:12px;padding:18px 20px}
          .eilif-arch .note h3{font-family:var(--serif);font-size:18px;margin:0 0 6px;font-weight:600}
          .eilif-arch .note p{margin:6px 0 0;font-size:14px;color:var(--ink-soft)}
          .eilif-arch .note b{color:var(--ink)}
          .eilif-arch footer{margin-top:50px;padding-top:18px;border-top:1px solid var(--line);color:var(--ink-faint);font-size:12.5px;font-family:var(--mono);line-height:1.7}
        `}</style>
      </div>
    </div>
  );
}
