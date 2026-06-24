import { SERVER_NAME } from '@/config/server';

export function Footer() {
  return (
    <footer className="mt-16 border-t border-rune bg-pitch/60">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-1 px-4 py-8 text-center sm:px-6">
        <p className="font-display text-sm tracking-wide text-ash-dim">{SERVER_NAME}</p>
        <p className="text-xs text-muted">
          Sailing the tenth world. May your axes stay sharp, vikings. ᚱᚢᚾᛖ
        </p>
      </div>
    </footer>
  );
}
