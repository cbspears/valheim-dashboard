// The launch-day header: a countdown to Session Zero, and the next steps that
// are not confirmed done.
//
// THE HONESTY THIS PANEL IS BUILT AROUND. Exactly one of the 23 steps in
// docs/LAUNCH-DAY.md leaves a trace in a table the cockpit can read (step 20:
// the pilot channel overrides in the bot's heartbeat, and whether any event row
// still predates launch day). Every other step is graded "not visible from
// here", and the page says so on each line rather than showing a tidy checklist
// that quietly means nothing. A launch checklist that ticks itself off wrongly
// is worse than no checklist, because somebody will trust it at 08:00 on the
// morning it matters.

import { Rocket, CircleDashed, CircleCheck, CircleHelp, User, Bot } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { Explain } from '@/components/ops/Explain';
import { formatDurationSec } from '@/lib/ops/window';
import {
  launchCountdownSec,
  daysUntilInZone,
  LAUNCH_TZ,
  stampInZone,
  type LaunchStepState,
  type LaunchMoment,
} from '@/lib/ops/horizon';
import { HORIZON_GLOSSARY } from '@/lib/ops/glossary-horizon';
import { Chip } from './Panel';

export function LaunchPanel({
  nowMs,
  moment,
  next,
  all,
}: {
  nowMs: number;
  moment: LaunchMoment;
  /** The next three steps that are not done. */
  next: LaunchStepState[];
  /** Every step, for the full list behind the disclosure. */
  all: LaunchStepState[];
}) {
  const sec = moment.atMs === null ? null : launchCountdownSec(nowMs, moment.atMs);
  const days = moment.atMs === null ? null : daysUntilInZone(nowMs, moment.atMs, LAUNCH_TZ);
  const stamp = moment.atMs === null ? '' : stampInZone(moment.atMs, LAUNCH_TZ);
  const past = sec !== null && sec < 0;
  const confirmed = all.filter((s) => s.status === 'done').length;

  return (
    <Card glow>
      <CardBody className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex items-start gap-3">
            <Rocket size={22} className="mt-0.5 shrink-0 text-gold" />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-sm uppercase tracking-wide text-ash">
                  {past ? 'Launch has begun' : 'Launch'}
                </h2>
                <Explain entry={HORIZON_GLOSSARY['launch-countdown']} size="sm" />
              </div>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-gold">
                {sec === null
                  ? 'no date'
                  : past
                    ? `${formatDurationSec(-sec)} in`
                    : `T minus ${formatDurationSec(sec)}`}
              </p>
              <p className="mt-1 text-xs text-muted">
                {days === null
                  ? 'The launch instant could not be resolved.'
                  : `${days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'} out`}, ${stamp} ${LAUNCH_TZ}.`}{' '}
                {moment.source === 'gathering'
                  ? 'Taken from the scheduled Discord gathering.'
                  : 'Taken from the runbook, 17:00 CT: no gathering is on the calendar for that date.'}
              </p>
            </div>
          </div>

          <div className="text-right">
            <p className="text-xs text-muted">Steps confirmed here</p>
            <p className="text-2xl font-semibold tabular-nums text-ash">
              {confirmed}
              <span className="text-base text-muted"> of {all.length}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              Only step 20 is checkable from the database.
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-rune pt-4">
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className="font-display text-xs uppercase tracking-wide text-ash-dim">
              Next up in the runbook
            </h3>
            <Explain entry={HORIZON_GLOSSARY['launch-steps']} size="sm" />
          </div>
          {next.length === 0 ? (
            <p className="text-sm text-online-glow">Every step is confirmed done.</p>
          ) : (
            <ol className="space-y-2.5">
              {next.map((s) => (
                <StepLine key={s.step.n} state={s} emphasis />
              ))}
            </ol>
          )}
        </div>

        <details className="mt-4 border-t border-rune pt-3">
          <summary className="cursor-pointer text-xs text-muted transition hover:text-ash-dim">
            All {all.length} steps, in order
          </summary>
          <ol className="mt-3 space-y-1.5">
            {all.map((s) => (
              <StepLine key={s.step.n} state={s} />
            ))}
          </ol>
        </details>
      </CardBody>
    </Card>
  );
}

function StepLine({ state, emphasis = false }: { state: LaunchStepState; emphasis?: boolean }) {
  const { step, status, evidence } = state;
  const Icon = status === 'done' ? CircleCheck : status === 'open' ? CircleDashed : CircleHelp;
  const iconTone =
    status === 'done' ? 'text-online-glow' : status === 'open' ? 'text-raid' : 'text-muted';
  return (
    <li className="flex items-start gap-2.5">
      <Icon size={14} className={`mt-0.5 shrink-0 ${iconTone}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xs tabular-nums text-muted">Step {step.n}</span>
          <span className={emphasis ? 'text-sm text-ash' : 'text-xs text-ash-dim'}>
            {step.title}
          </span>
          <Chip tone={step.owner === 'Charlie' ? 'gold' : 'muted'}>
            {step.owner === 'Claude' ? <Bot size={11} aria-hidden="true" /> : <User size={11} aria-hidden="true" />}
            {step.owner}
          </Chip>
          {step.checkedHere && <Chip tone="good">checked here</Chip>}
        </div>
        {emphasis && (
          <p className="mt-0.5 text-xs text-muted">
            {step.note ? `${step.note} ` : ''}
            {evidence}
          </p>
        )}
      </div>
    </li>
  );
}
