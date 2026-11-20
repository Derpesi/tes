import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DAMARINDO GROUP HRIS',
  description: 'Sistem informasi sumber daya manusia DAMARINDO GROUP',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b1f3a' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
