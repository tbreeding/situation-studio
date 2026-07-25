import type { Metadata, Viewport } from "next";
import "./studio.css";

export const metadata: Metadata = {
  title: "Situation Studio",
  description: "The private editorial workbench for Leadership situations.",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#f5f2ec",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
