import type { Metadata, Viewport } from "next";
import "./studio.css";

export const metadata: Metadata = {
  title: { default: "Situation Studio", template: "%s · Situation Studio" },
  description:
    "Private leadership situation authoring, review, and publication studio.",
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#14261f",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
