import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";

const sans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AMRL Media — client onboarding",
  description:
    "A clean V1 onboarding workflow: form to Google Sheet to Drive folder to Gmail alert, with payment and delivery tracking. Ships as a Make.com blueprint, an n8n workflow and a working reference implementation.",
  openGraph: {
    title: "Client onboarding workflow",
    description: "Send a brief and watch every step run, including the ones that fail.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#14563f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${sans.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
