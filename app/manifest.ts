import type { MetadataRoute } from 'next';
import { SERVER_NAME, SERVER_TAGLINE } from '@/config/server';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SERVER_NAME,
    short_name: SERVER_NAME,
    description: SERVER_TAGLINE,
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0d13',
    theme_color: '#0a0d13',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-192-maskable.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
