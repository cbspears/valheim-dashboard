// Ops cockpit logout — clears the session cookie.

import { cookies } from 'next/headers';
import { COOKIE_NAME, cookieOptions } from '@/lib/ops/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const store = await cookies();
  // Overwrite with an immediately-expiring cookie (maxAge 0).
  store.set(COOKIE_NAME, '', cookieOptions(0));
  return Response.json({ ok: true }, { status: 200 });
}
