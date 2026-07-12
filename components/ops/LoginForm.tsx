'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Minimal ops login form. Posts the password to /api/ops/login; on success the
 * server sets the signed cookie and we push to the cockpit. No password is ever
 * stored client-side beyond the input value.
 */
export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ops/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push('/admin/ops');
        router.refresh();
        return;
      }
      setError(res.status === 429 ? 'Too many attempts — wait a moment.' : 'Incorrect password.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="ops-password" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
          Password
        </label>
        <input
          id="ops-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-rune bg-pitch px-3 py-2 text-ash outline-none focus:border-gold-dim"
          autoFocus
        />
      </div>
      {error && <p className="text-sm text-death">{error}</p>}
      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="w-full rounded-md border border-gold-dim/60 bg-gold/10 px-4 py-2 font-display text-sm uppercase tracking-wide text-gold-light transition hover:bg-gold/20 disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Enter'}
      </button>
    </form>
  );
}
