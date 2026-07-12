import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Activity, ListChecks, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { StateChip, SeverityChip } from '@/components/ops/StateChip';
import { OpsControls } from '@/components/ops/OpsControls';
import { ageLabel, cadenceLabel } from '@/components/ops/format';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import { loadOpsData } from '@/lib/ops/db';
import { buildHealth, type ComponentReport, type ComponentGroup } from '@/lib/ops/health';
import { runConsistencyChecks } from '@/lib/ops/consistency';

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
  const nowMs = Date.now();
  const data = await loadOpsData(nowMs);
  const reports = buildHealth({
    nowMs,
    supabaseOk: data.supabaseOk,
    dashboardVersion: data.dashboardVersion,
    serverStatusUpdatedAt: data.serverStatusUpdatedAt,
    heartbeats: data.heartbeats,
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
              What is running, and what has drifted. Observational only — no controls here.
            </p>
          </div>
        </div>
        <OpsControls renderedAtIso={renderedAt} />
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

      <p className="pt-2 text-xs text-muted">
        {data.supabaseOk
          ? 'Data read live with the service role at render time.'
          : 'Database unreachable or unconfigured — most signals below show as unknown.'}
      </p>
    </div>
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
