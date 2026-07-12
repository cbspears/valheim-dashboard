// Ops cockpit login — verifies the password and sets the signed session cookie.
//
// FAIL CLOSED: verifyPassword() and signSession() both return false/null when
// OPS_PASSWORD is unset, so an unconfigured cockpit can never be logged into.

import { cookies } from 'next/headers';
import { rateLimit, ipFromRequest } from '@/lib/rate-limit';
import {
  COOKIE_NAME,
  SESSION_TTL_SEC,
  cookieOptions,
  verifyPassword,
  signSession,
} from '@/lib/ops/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  // A tighter limit than ingest — this is a password endpoint.
  if (!rateLimit(`ops-login:${ipFromRequest(request)}`, 10, 60_000)) {
    return Response.json({ error: 'rate limited' }, { status: 429 });
  }

  let body: { password?: unknown };
  try {
    body = (await request.json()) as { password?: unknown };
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!verifyPassword(body.password)) {
    return Response.json({ error: 'invalid password' }, { status: 401 });
  }

  const value = signSession();
  if (!value) {
    // Belt-and-suspenders: password verified but signing failed → still closed.
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }

  const store = await cookies();
  store.set(COOKIE_NAME, value, cookieOptions(SESSION_TTL_SEC));
  return Response.json({ ok: true }, { status: 200 });
}
