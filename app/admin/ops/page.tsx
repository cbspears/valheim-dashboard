import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Activity, ListChecks, ShieldAlert, CheckCircle2, Network, BookOpen, ChevronRight, ExternalLink, Volume2, Fingerprint } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { StateChip, SeverityChip } from '@/components/ops/StateChip';
import { OpsControls } from '@/components/ops/OpsControls';
import { ageLabel, cadenceLabel } from '@/components/ops/format';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import { loadOpsData, type IdentityMismatchEvent } from '@/lib/ops/db';
import {
  buildHealth,
  VOICE_QUEUE_DEGRADED_SEC,
  type ComponentReport,
  type ComponentGroup,
} from '@/lib/ops/health';
import { runConsistencyChecks } from '@/lib/ops/consistency';
import { releaseBindingSql } from '@/lib/ops/release-sql';

// Auth-gated + always fresh; never statically rendered.
export const dynamic = 'force-dynamic';

const GROUP_TITLES: Record<ComponentGroup, { title: string; subtitle: string }> = {
  core: { title: 'Dashboard & database', subtitle: 'Alive because this page rendered.' },
  pipeline: { title: 'Ingest pipeline', subtitle: 'The runners that feed the saga.' },
  'bot-loop': { title: 'Bot loops', subtitle: 'Sub-tasks reported by the Discord bot.' },
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
    botFlags: data.botFlags,
    demoDiscordEvents: data.demoDiscordEvents,
    tablePresence: data.tablePresence,
  });

  const renderedAt = new Date(nowMs).toISOString();
  const groups: ComponentGroup[] = ['core', 'pipeline', 'bot-loop'];

  // Header roll-up counts.
  const counts = reports.reduce(
    (acc, r) => {
      acc[r.state] = (acc[r.state] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-8">
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
        <div className="flex items-center gap-3">
          <Link
            href="/admin/ops/architecture"
            className="inline-flex items-center gap-1.5 rounded-md border border-rune bg-surface-raised px-3 py-1.5 text-xs font-medium text-ash-dim transition hover:border-gold-dim hover:text-ash"
          >
            <Network size={14} />
            Architecture
          </Link>
          <OpsControls renderedAtIso={renderedAt} />
        </div>
      </header>

      {/* Roll-up ribbon */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['healthy', 'degraded', 'stale', 'unknown', 'disabled'] as const)
          .filter((s) => counts[s])
          .map((s) => (
            <span key={s} className="rounded-full border border-rune bg-surface px-3 py-1 text-ash-dim">
              <span className="font-semibold text-ash">{counts[s]}</span> {s}
            </span>
          ))}
      </div>

      {/* Needs attention */}
      <section>
        <div className="mb-3 flex items-center gap-2.5">
          <ShieldAlert size={18} className="text-gold" />
          <h2 className="font-display text-sm uppercase tracking-wide text-ash">Needs attention</h2>
          <span className="text-xs text-muted">{findings.length} open</span>
        </div>
        {findings.length === 0 ? (
          <Card>
            <CardBody className="flex items-center gap-3 text-ash-dim">
              <CheckCircle2 size={18} className="text-online-glow" />
              <span>Nothing flagged. The realm holds.</span>
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-2.5">
            {findings.map((f) => (
              <Card key={f.id}>
                <CardBody className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                  <SeverityChip severity={f.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ash">{f.title}</p>
                    <p className="mt-0.5 text-sm text-ash-dim">{f.detail}</p>
                    <p className="mt-1.5 flex gap-1.5 text-sm text-muted">
                      <ListChecks size={15} className="mt-0.5 shrink-0 text-gold-dim" />
                      <span>{f.whatToDo}</span>
                    </p>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Component health, grouped */}
      {groups.map((group) => {
        const rows = reports.filter((r) => r.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group}>
            <div className="mb-3">
              <h2 className="font-display text-sm uppercase tracking-wide text-ash">{GROUP_TITLES[group].title}</h2>
              <p className="text-xs text-muted">{GROUP_TITLES[group].subtitle}</p>
            </div>
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-rune text-xs uppercase tracking-wider text-muted">
                      <th className="px-4 py-2.5 font-medium">Component</th>
                      <th className="px-4 py-2.5 font-medium">State</th>
                      <th className="px-4 py-2.5 font-medium">Last success</th>
                      <th className="px-4 py-2.5 font-medium">Cadence</th>
                      <th className="px-4 py-2.5 font-medium">Version</th>
                      <th className="px-4 py-2.5 font-medium">Notes</th>
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
        <div className="mb-3 flex items-center gap-2.5">
          <Volume2 size={18} className="text-gold" />
          <h2 className="font-display text-sm uppercase tracking-wide text-ash">Voice queue</h2>
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
        <div className="mb-3 flex items-center gap-2.5">
          <Fingerprint size={18} className="text-gold" />
          <h2 className="font-display text-sm uppercase tracking-wide text-ash">Identity mismatches</h2>
          <span className="text-xs text-muted">last 7 days</span>
        </div>
        <IdentityMismatches rows={data.identityMismatches} truncated={data.identityMismatchesTruncated} />
      </section>

      <p className="pt-2 text-xs text-muted">
        {data.supabaseOk
          ? 'Data read live with the service role at render time.'
          : 'Database unreachable or unconfigured. Most signals below show as unknown.'}
      </p>

      {/* Resources — reference material, not live signals. */}
      <section>
        <div className="mb-3 flex items-center gap-2.5">
          <BookOpen size={18} className="text-gold" />
          <h2 className="font-display text-sm uppercase tracking-wide text-ash">Resources</h2>
        </div>
        <Card>
          <CardBody className="py-1">
            <ul className="divide-y divide-rune/50 text-sm">
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
          <span>No mismatches recorded in the last 7 days. Every viking answered to its own name.</span>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-rune text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-2.5 font-medium">Character</th>
              <th className="px-4 py-2.5 font-medium">Bound Steam ID</th>
              <th className="px-4 py-2.5 font-medium">Seen Steam ID</th>
              <th className="px-4 py-2.5 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.characterName}-${r.at}`} className="border-b border-rune/50 last:border-0">
                <td className="px-4 py-3 font-medium text-ash">{r.characterName}</td>
                <td className="px-4 py-3 font-mono text-xs text-ash-dim">
                  {r.boundSteamId ?? <span className="text-muted">unknown</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-death">
                  {r.seenSteamId ?? <span className="text-muted">unknown</span>}
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
        <p>
          The bound account keeps the name. Oaths, pins and the Discord link stay frozen for it until
          an admin releases the binding in Supabase, and the next join binds it fresh. One statement
          per character above, so releasing one name never quietly leaves another frozen:
        </p>
        {/* Escaped + one statement per character in lib/ops/release-sql (tested
            there): the name is unvalidated player input and this block is meant
            to be pasted into Supabase under the service role. */}
        <pre className="mt-1.5 overflow-x-auto rounded border border-rune bg-surface-raised px-2.5 py-1.5 font-mono text-[11px] text-ash-dim">
          {releaseBindingSql(rows.map((r) => r.characterName))}
        </pre>
      </CardBody>
    </Card>
  );
}

function HealthRow({ r }: { r: ComponentReport }) {
  return (
    <tr className="border-b border-rune/50 last:border-0 align-top">
      <td className="px-4 py-3">
        <div className="font-medium text-ash">{r.label}</div>
        <div className="font-mono text-xs text-muted">{r.key}</div>
      </td>
      <td className="px-4 py-3">
        <StateChip state={r.state} />
        {r.ageSec !== null && <div className="mt-1 text-xs text-muted">{ageLabel(r.ageSec)} ago</div>}
      </td>
      <td className="px-4 py-3 text-ash-dim">
        {r.lastSuccess ? new Date(r.lastSuccess).toLocaleString() : <span className="text-muted">never</span>}
      </td>
      <td className="px-4 py-3 text-ash-dim">{cadenceLabel(r.cadenceSec)}</td>
      <td className="px-4 py-3 font-mono text-xs text-ash-dim">{r.version ?? <span className="text-muted">unknown</span>}</td>
      <td className="px-4 py-3">
        <div className="max-w-md text-xs text-muted">{r.detail}</div>
        {r.lastError && <div className="mt-1 max-w-md text-xs text-death">{r.lastError}</div>}
        {r.flags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {r.flags.map((f) => (
              <span key={f.label} className="rounded border border-rune bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-ash-dim">
                {f.label}={f.value}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
