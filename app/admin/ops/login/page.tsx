import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ShieldCheck } from 'lucide-react';
import { Card, CardBody } from '@/components/ui';
import { LoginForm } from '@/components/ops/LoginForm';
import { COOKIE_NAME, verifySession } from '@/lib/ops/auth';
import { SERVER_NAME } from '@/config/server';

export const dynamic = 'force-dynamic';

export default async function OpsLoginPage() {
  // Already authed? Skip straight to the cockpit. (verifySession fails closed when
  // OPS_PASSWORD is unset, so this never wrongly redirects an unconfigured site.)
  const store = await cookies();
  if (verifySession(store.get(COOKIE_NAME)?.value)) {
    redirect('/admin/ops');
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <div className="mb-6 flex items-center gap-3">
        <ShieldCheck size={24} className="text-gold" />
        <div>
          <h1 className="heading-engraved text-xl text-ash">Operations</h1>
          <p className="text-sm text-muted">The watchfire is for the keepers of {SERVER_NAME}.</p>
        </div>
      </div>
      <Card>
        <CardBody>
          <LoginForm />
        </CardBody>
      </Card>
    </div>
  );
}
