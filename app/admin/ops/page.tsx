import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Fingerprint,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  Users,
  Volume2,
} from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { StateChip, SeverityChip } from '@/components/ops/StateChip';
import { OpsControls } from '@/components/ops/OpsControls';
import { OpsNav } from '@/components/ops/OpsNav';
import { Explain } from '@/components/ops/Explain';
import { ExplainTerm } from '@/components/ops/ExplainTerm';
import { ExplainIndex } from '@/components/ops/ExplainIndex';
import { InsightsStrip } from '@/components/ops/insights/InsightsStrip';
import { ageLabel, cadenceLabel } from '@/components/ops/format';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import { loadOpsData, type IdentityMismatchEvent } from '@/lib/ops/db';
import {
  buildHealth,
  VOICE_QUEUE_DEGRADED_SEC,
  type ComponentReport,
  type ComponentGroup,
  type HealthState,
} from '@/lib/ops/health';
import { runConsistencyChecks } from '@/lib/ops/consistency';
import { summarizeOps, type OpsVerdictLevel } from '@/lib/ops/overview';
import { CONSISTENCY_CONDITION_COUNT, GLOSSARY, glossaryEntry } from '@/lib/ops/glossary';
import { releaseBindingSql } from '@/lib/ops/release-sql';

// Auth-gated + always fresh; never statically rendered.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Eilif · Ops Overview' },
};

const GROUP_TITLES: Record<
  ComponentGroup,
  {
    title: string;
    subtitle: string;
    /** Caption for the group heading itself. */
    explain: string;
    /**
     * Further captions, rendered as named terms under the subtitle rather than
     * as more bare info buttons beside the heading. Two identical icons side by
     * side say nothing about which is which.
     */
    more: string[];
  }
> = {
  core: {
    title: 'Dashboard & database',
    subtitle: 'Alive because this page rendered. Point-in-time proof, with no history behind it.',
    explain: 'render-liveness',
    more: [],
  },
  pipeline: {
    title: 'Ingest pipeline',
    subtitle:
      'The six producers that feed the saga. Three report for themselves, three are inferred from what they touch.',
    explain: 'heartbeat-source',
    more: ['inferred-vs-measured'],
  },
  'bot-loop': {
    title: 'Bot loops',
    subtitle: 'Seven timers inside the one Discord bot process, not seven processes.',
    explain: 'bot-subloop',
    more: ['subloop-unknown-when-parent-down'],
  },
};

/** Verdict colour, one place, so the icon and the rule can never disagree. */
const VERDICT_STYLES: Record<
  OpsVerdictLevel,
  { cls: string; ring: string; Icon: typeof CheckCircle2 }
> = {
  clear: { cls: 'text-online-glow', ring: 'border-online/40', Icon: ShieldCheck },
  watch: { cls: 'text-frost', ring: 'border-frost/40', Icon: Activity },
  attention: { cls: 'text-raid', ring: 'border-raid/40', Icon: AlertTriangle },
  incident: { cls: 'text-death', ring: 'border-death/40', Icon: ShieldAlert },
};

/** State chip in the strip, with the count and its own caption. */
const STATE_ORDER: HealthState[] = ['healthy', 'degraded', 'stale', 'unknown', 'disabled'];
const STATE_GLOSSARY: Record<HealthState, string> = {
  healthy: 'state-healthy',
  degraded: 'state-degraded',
  stale: 'state-stale',
  unknown: 'state-unknown',
  disabled: 'state-disabled',
};

export default async function OpsPage() {
  // ---- Auth gate (fail closed) --------------------------------------------
  const store = await cookies();
  if (!verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops/login');
  }

  // ---- Load + compute (all server-side, service role) ---------------------
  const data = await loadOpsData();
  const nowMs = data.nowMs;
  const reports = buildHealth({
    nowMs,
    supabaseOk: data.supabaseOk,
    dashboardVersion: data.dashboardVersion,
    serverStatusUpdatedAt: data.serverStatusUpdatedAt,
    heartbeats: data.heartbeats,
    // Passed by name as well as riding along in the companion-voice heartbeat
    // metrics: the row only exists once that plugin has polled at least once, and
    // a stalled queue is exactly the case where it might not have.
    voiceQueueOldestSec: data.voiceQueueOldestSec,
    // The Companion polls /api/voice only while somebody is connected, so an
    // empty hall must not read as a dead in-game voice half.
    playersOnline: data.serverCurrentPlayers.length,
  });
  const findings = runConsistencyChecks({
    nowMs,
    serverStatusUpdatedAt: data.serverStatusUpdatedAt,
    serverCurrentPlayers: data.serverCurrentPlayers,
    onlinePlayerNames: data.onlinePlayerNames,
    latestPresenceByName: data.latestPresenceByName,
    openSessions: data.openSessions,
    mapSnapshotLastSuccess: data.mapSnapshotLastSuccess,
    unannouncedMilestones: data.unannouncedMilestones,
    unannouncedIdentityConfirmations: data.unannouncedIdentityConfirmations,
    expiredUnconsumedClaims: data.expiredUnconsumedClaims,
    statPoisonReporters: data.statPoisonReporters,
    futureDatedEvents: data.futureDatedEvents,
    botFlags: data.botFlags,
    demoDiscordEvents: data.demoDiscordEvents,
    tablePresence: data.tablePresence,
  });

  // The one-line answer to "is everything fine", from what is already loaded.
  // Adds no queries: pure, and tested in lib/ops/overview.test.mjs.
  const verdict = summarizeOps({ reports, findings });

  const renderedAt = new Date(nowMs).toISOString();
  const groups: ComponentGroup[] = ['core', 'pipeline', 'bot-loop'];
  const playersOnline = data.serverCurrentPlayers.length;
  const emitterAgeSec = data.serverStatusUpdatedAt
    ? Math.max(0, (nowMs - Date.parse(data.serverStatusUpdatedAt)) / 1000)
    : null;

  return (
    <div className="space-y-8">
      <OpsNav active="overview" />

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Activity size={24} className="text-gold" />
          <div>
            <h1 className="heading-engraved text-2xl text-ash">Operations</h1>
            <p className="text-sm text-muted">
              What is running, and what has drifted. Observational only, with no controls here.
            </p>
          </div>
        </div>
        <OpsControls renderedAtIso={renderedAt} />
      </header>

      {/* ── Status strip: the answer to "is everything fine", in one line ──
          Everything in it is derived from the two computations above, so it
          costs no extra query. The roll-up counts that used to sit loose under
          the header live here now, each with its own explanation. */}
      <StatusStrip
        verdict={verdict}
        renderedAt={renderedAt}
        playersOnline={playersOnline}
        emitterAgeSec={emitterAgeSec}
        supabaseOk={data.supabaseOk}
      />

      {/* Insights: the same data, read for what is worth saying about it.
          Fetches its own rows, renders its own section, never throws. */}
      <InsightsStrip nowMs={nowMs} />

      {/* Needs attention */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <ShieldAlert size={18} className="text-gold" />
          <h2 className="font-display text-sm tracking-wide text-ash uppercase">Needs attention</h2>
          <Explain entry={GLOSSARY['consistency-check']} size="md" />
          <span className="text-xs text-muted">
            {findings.length === 0
              ? `none open, of ${CONSISTENCY_CONDITION_COUNT} conditions checked this render`
              : `${findings.length} open, of ${CONSISTENCY_CONDITION_COUNT} conditions checked this render`}
          </span>
          <ExplainTerm
            entry={GLOSSARY['severity-levels']}
            labelClassName="text-xs text-muted"
            underline
          >
            worst first
          </ExplainTerm>
        </div>
        {findings.length === 0 ? (
          <Card>
            <CardBody className="flex items-center gap-3 text-ash-dim">
              <CheckCircle2 size={18} className="text-online-glow" />
              <span>
                Nothing flagged. All {CONSISTENCY_CONDITION_COUNT} conditions were checked against
                live data this render and none fired.
              </span>
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-2.5">
            {findings.map((f) => {
              const entry = glossaryEntry(`check:${f.id}`);
              return (
                <Card key={f.id}>
                  <CardBody className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                    <SeverityChip severity={f.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 font-medium text-ash">
                        {f.title}
                        {entry && <Explain entry={entry} align="start" />}
                      </p>
                      <p className="mt-0.5 text-sm text-ash-dim">{f.detail}</p>
                      <p className="mt-1.5 flex gap-1.5 text-sm text-muted">
                        <ListChecks size={15} className="mt-0.5 shrink-0 text-gold" />
                        <span>{f.whatToDo}</span>
                      </p>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Component health, grouped */}
      {groups.map((group) => {
        const rows = reports.filter((r) => r.group === group);
        if (rows.length === 0) return null;
        const meta = GROUP_TITLES[group];
        return (
          <section key={group}>
            <div className="mb-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-sm tracking-wide text-ash uppercase">
                  {meta.title}
                </h2>
                {(() => {
                  const entry = glossaryEntry(meta.explain);
                  return entry ? <Explain entry={entry} size="md" /> : null;
                })()}
                <span className="text-xs text-muted">
                  {rows.length} {rows.length === 1 ? 'row' : 'rows'}
                </span>
              </div>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                {meta.subtitle}
                {meta.more.map((id) => {
                  const entry = glossaryEntry(id);
                  return entry ? (
                    <ExplainTerm key={id} entry={entry} labelClassName="text-xs text-muted" underline />
                  ) : null;
                })}
              </p>
            </div>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-rune text-xs tracking-wider text-muted uppercase">
                      <th className="px-4 py-2.5 font-medium">Component</th>
                      <th className="px-4 py-2.5 font-medium">
                        <ExplainTerm entry={GLOSSARY['stale-vs-unknown']}>State</ExplainTerm>
                      </th>
                      <th className="px-4 py-2.5 font-medium">
                        <ExplainTerm entry={GLOSSARY['last-success']}>Last success</ExplainTerm>
                      </th>
                      <th className="px-4 py-2.5 font-medium">
                        <ExplainTerm entry={GLOSSARY['cadence-vs-stale']}>Cadence</ExplainTerm>
                      </th>
                      <th className="px-4 py-2.5 font-medium">
                        <ExplainTerm entry={GLOSSARY['component-version']}>Version</ExplainTerm>
                      </th>
                      <th className="px-4 py-2.5 font-medium">
                        <ExplainTerm entry={GLOSSARY['component-notes']}>Notes</ExplainTerm>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <HealthRow key={r.key} r={r} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        );
      })}

      {/* Voice queue depth — the second, independent signal for the in-game
          voice half. The heartbeat above says the Companion is polling; this
          says whether the lines it should be speaking are leaving the queue. */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <Volume2 size={18} className="text-gold" />
          <h2 className="font-display text-sm tracking-wide text-ash uppercase">Voice queue</h2>
          <Explain entry={GLOSSARY['voice-queue-age']} size="md" />
          <span className="text-xs text-muted">measured only while a viking is connected</span>
          <Explain entry={GLOSSARY['quiet-hall-rule']} />
        </div>
        <Card>
          <CardBody className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm text-ash-dim">Oldest line waiting</span>
              <span className="font-mono text-lg text-ash">
                {data.voiceQueueOldestSec === null ? 'none' : ageLabel(data.voiceQueueOldestSec)}
              </span>
              {data.voiceQueueOldestSec !== null &&
                data.voiceQueueOldestSec >= VOICE_QUEUE_DEGRADED_SEC && (
                  <StateChip state="degraded" />
                )}
            </div>
            <p className="text-xs text-muted">
              {data.voiceQueueOldestSec === null
                ? 'Nothing queued, or nobody is on the server. The queue is only measured while a viking is connected.'
                : `Queued for ${ageLabel(data.voiceQueueOldestSec)} with players online. Anything past ${Math.round(
                    VOICE_QUEUE_DEGRADED_SEC / 60,
                  )} minutes means the Companion is polling but not speaking.`}
            </p>
          </CardBody>
        </Card>
      </section>

      {/* Steam identity mismatches — a join under an account other than the one
          bound to that character name. Presence is still recorded; the name's
          oath, pin and Discord-link writes are frozen until an admin releases it. */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <Fingerprint size={18} className="text-gold" />
          <h2 className="font-display text-sm tracking-wide text-ash uppercase">
            Identity mismatches
          </h2>
          <Explain entry={GLOSSARY['steam-mismatch']} size="md" />
          <span className="text-xs text-muted">last 7 days</span>
        </div>
        <IdentityMismatches
          rows={data.identityMismatches}
          truncated={data.identityMismatchesTruncated}
        />
      </section>

      <p className="flex flex-wrap items-center gap-1.5 pt-2 text-xs text-muted">
        {data.supabaseOk
          ? 'Data read live with the service role at render time. Nothing on this page is cached.'
          : 'Database unreachable or unconfigured. Most signals above show as unknown.'}
        <Explain entry={GLOSSARY['service-role-read']} />
      </p>

      {/* The whole glossary, filterable. The same text the buttons above open,
          reachable without hunting for the button that owns it. */}
      <ExplainIndex />

      {/* Resources — reference material, not live signals. */}
      <section>
        <div className="mb-3 flex items-center gap-2.5">
          <BookOpen size={18} className="text-gold" />
          <h2 className="font-display text-sm tracking-wide text-ash uppercase">Resources</h2>
        </div>
        <Card>
          <CardBody className="py-1">
            <ul className="divide-rune/50 divide-y text-sm">
              <li>
                <Link
                  href="/admin/ops/architecture"
                  className="group flex items-center justify-between gap-3 py-2.5 text-ash-dim transition hover:text-ash"
                >
                  <span>System architecture</span>
                  <ChevronRight size={15} className="text-muted transition group-hover:text-gold" />
                </Link>
              </li>
              <li>
                <a
                  href="https://github.com/cbspears/valheim-dashboard/blob/main/docs/OPS-COCKPIT.md"
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center justify-between gap-3 py-2.5 text-ash-dim transition hover:text-ash"
                >
                  <span>Ops runbook</span>
                  <ExternalLink size={14} className="text-muted transition group-hover:text-gold" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/cbspears/valheim-dashboard/blob/main/docs/LAUNCH-DAY.md"
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center justify-between gap-3 py-2.5 text-ash-dim transition hover:text-ash"
                >
                  <span>Launch day runbook</span>
                  <ExternalLink size={14} className="text-muted transition group-hover:text-gold" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/cbspears/valheim-dashboard"
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center justify-between gap-3 py-2.5 text-ash-dim transition hover:text-ash"
                >
                  <span>Source repository</span>
                  <ExternalLink size={14} className="text-muted transition group-hover:text-gold" />
                </a>
              </li>
              <li>
                <a
                  href="https://claude.ai/code/artifact/3182f247-c9bf-442a-bbf7-3163ea1e176d"
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center justify-between gap-3 py-2.5 text-ash-dim transition hover:text-ash"
                >
                  <span>Full-screen architecture diagram</span>
                  <ExternalLink size={14} className="text-muted transition group-hover:text-gold" />
                </a>
              </li>
            </ul>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}

/**
 * The one-line answer, plus the evidence behind it.
 *
 * Deliberately the first thing under the header: on launch night the question is
 * not "what is the state of every moving part", it is "do I need to do something
 * right now", and that used to require reading the whole page.
 */
function StatusStrip({
  verdict,
  renderedAt,
  playersOnline,
  emitterAgeSec,
  supabaseOk,
}: {
  verdict: ReturnType<typeof summarizeOps>;
  renderedAt: string;
  playersOnline: number;
  emitterAgeSec: number | null;
  supabaseOk: boolean;
}) {
  const style = VERDICT_STYLES[verdict.level];
  const { Icon } = style;
  return (
    <Card className={style.ring}>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Icon size={26} className={`mt-0.5 shrink-0 ${style.cls}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={`font-display text-xl tracking-wide ${style.cls}`}>
                {verdict.headline}
              </h2>
              <Explain entry={GLOSSARY['ops-verdict']} size="md" align="start" />
            </div>
            <p className="mt-1 text-sm text-ash-dim">{verdict.detail}</p>
          </div>
        </div>

        {/* Counts by state. Absence of a chip means zero of that state. */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <ExplainTerm
            entry={GLOSSARY['roll-up-counts']}
            labelClassName="text-xs tracking-wider text-muted uppercase"
          >
            Components
          </ExplainTerm>
          {STATE_ORDER.filter((s) => verdict.counts[s] > 0).map((s) => {
            const entry = glossaryEntry(STATE_GLOSSARY[s]);
            return (
              <span
                key={s}
                className="inline-flex items-center gap-1.5 rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim"
              >
                <span className="font-semibold text-ash">{verdict.counts[s]}</span> {s}
                {entry && <Explain entry={entry} align="start" />}
              </span>
            );
          })}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim">
            <span className="font-semibold text-ash">{verdict.openFindings}</span>{' '}
            {verdict.openFindings === 1 ? 'check open' : 'checks open'}
            <Explain entry={GLOSSARY['consistency-check']} align="start" />
          </span>
        </div>

        {/* Two facts that frame everything above, both already loaded. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-rune/50 pt-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Users size={13} aria-hidden="true" />
            <span className="font-semibold text-ash-dim">{playersOnline}</span>
            {playersOnline === 1 ? 'viking online' : 'vikings online'}
            <span>
              (from server_status,{' '}
              {emitterAgeSec === null ? 'never written' : `${ageLabel(emitterAgeSec)} old`})
            </span>
          </span>
          <span>
            Read live at {renderedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}
            {supabaseOk ? '' : ', database unreachable'}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

function IdentityMismatches({
  rows,
  truncated,
}: {
  rows: IdentityMismatchEvent[];
  truncated: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardBody className="flex items-center gap-3 text-ash-dim">
          <CheckCircle2 size={18} className="text-online-glow" />
          <span>
            No mismatches recorded in the last 7 days. Every viking answered to its own name.
          </span>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-rune text-xs tracking-wider text-muted uppercase">
              <th className="px-4 py-2.5 font-medium">Character</th>
              <th className="px-4 py-2.5 font-medium">Bound Steam ID</th>
              <th className="px-4 py-2.5 font-medium">
                <ExplainTerm entry={GLOSSARY['identity-fingerprint']}>Joining account</ExplainTerm>
              </th>
              <th className="px-4 py-2.5 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.characterName}-${r.at}`} className="border-b border-rune/50 last:border-0">
                <td className="px-4 py-3 font-medium text-ash">{r.characterName}</td>
                <td className="px-4 py-3 font-mono text-xs text-ash-dim">
                  {r.boundSteamId ?? (
                    <span className="text-muted">
                      {r.boundSteamIdHash ? `released (was ${r.boundSteamIdHash})` : 'unknown'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-death">
                  {r.seenSteamIdHash ?? <span className="text-muted">unknown</span>}
                </td>
                <td className="px-4 py-3 text-ash-dim">{new Date(r.at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CardBody className="border-t border-rune/50 text-xs text-muted">
        {truncated && (
          <p className="mb-1.5 text-ash-dim">
            Showing the {rows.length} newest. More were recorded in this window.
          </p>
        )}
        <p className="mb-1.5">
          The bound Steam ID is read live from{' '}
          <span className="font-mono text-ash-dim">players</span> under the service role. The
          joining account is shown as a 12-character fingerprint: the event row that records a
          mismatch is readable by anyone with the publishable key, so it stores no Steam ID. The
          full ID of whoever joined is in the bot host&apos;s journal, on the{' '}
          <span className="font-mono text-ash-dim">STEAM MISMATCH</span> line for this character.
        </p>
        <p className="flex flex-wrap items-center gap-1.5">
          The bound account keeps the name. Oaths, pins and the Discord link stay frozen for it
          until an admin releases the binding in Supabase, and the next join binds it fresh. One
          statement per character above, so releasing one name never quietly leaves another frozen:
          <Explain entry={GLOSSARY['binding-release']} />
        </p>
        {/* Escaped + one statement per character in lib/ops/release-sql (tested
            there): the name is unvalidated player input and this block is meant
            to be pasted into Supabase under the service role. */}
        <pre className="mt-1.5 overflow-x-auto rounded border border-rune bg-surface-raised px-2.5 py-1.5 font-mono text-xs text-ash-dim">
          {releaseBindingSql(rows.map((r) => r.characterName))}
        </pre>
      </CardBody>
    </Card>
  );
}

function HealthRow({ r }: { r: ComponentReport }) {
  const entry = glossaryEntry(`component:${r.key}`);
  return (
    <tr className="border-b border-rune/50 align-top last:border-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 font-medium text-ash">
          {r.label}
          {entry && <Explain entry={entry} align="start" />}
        </div>
        <div className="font-mono text-xs text-muted">{r.key}</div>
      </td>
      <td className="px-4 py-3">
        <StateChip state={r.state} />
        {r.ageSec !== null && <div className="mt-1 text-xs text-muted">{ageLabel(r.ageSec)} ago</div>}
      </td>
      <td className="px-4 py-3 text-ash-dim">
        {r.lastSuccess ? new Date(r.lastSuccess).toLocaleString() : <span className="text-muted">never</span>}
      </td>
      <td className="px-4 py-3 text-ash-dim">
        {cadenceLabel(r.cadenceSec)}
        {r.staleAfterSec > 0 && (
          <div className="text-xs text-muted">stale past {cadenceLabel(r.staleAfterSec)}</div>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-ash-dim">{r.version ?? <span className="text-muted">unknown</span>}</td>
      <td className="px-4 py-3">
        <div className="max-w-md text-xs text-muted">{r.detail}</div>
        {r.lastError && <div className="mt-1 max-w-md text-xs text-death">{r.lastError}</div>}
        {r.flags.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {r.flags.map((f) => (
              <span key={f.label} className="rounded border border-rune bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-ash-dim">
                {f.label}={f.value}
              </span>
            ))}
            <Explain entry={GLOSSARY['component-flags']} align="start" />
          </div>
        )}
      </td>
    </tr>
  );
}
