import type { Metadata } from 'next';
import { Cinzel, Inter } from 'next/font/google';
import './globals.css';
import { NavBar } from '@/components/NavBar';
import { Footer } from '@/components/Footer';
import { SERVER_NAME, SERVER_TAGLINE, SERVER_DESCRIPTION } from '@/config/server';
import { art, HEADER_ART } from '@/config/art';

// Social card: swap in the baked-in reference art (00) once it lands; until
// then art() returns null and we keep the current /og-eilif.jpg exactly.
const ogArt = art(HEADER_ART.og);
const ogImageUrl = ogArt?.src ?? '/og-eilif.jpg';

const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-cinzel',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://valheim-dashboard.vercel.app'),
  title: {
    default: `${SERVER_NAME} — Valheim Server`,
    template: `%s · ${SERVER_NAME}`,
  },
  description: SERVER_DESCRIPTION,
  openGraph: {
    title: `${SERVER_NAME} — ${SERVER_TAGLINE}`,
    description: SERVER_DESCRIPTION,
    siteName: SERVER_NAME,
    type: 'website',
    images: [
      { url: ogImageUrl, width: 1200, height: 630, alt: `${SERVER_NAME} — ${SERVER_TAGLINE}` },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SERVER_NAME} — ${SERVER_TAGLINE}`,
    description: SERVER_DESCRIPTION,
    images: [ogImageUrl],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${cinzel.variable} ${inter.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <NavBar />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
