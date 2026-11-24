import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FloorPoV: World of Warcraft recording with combat log markers",
  description:
    "FloorPoV records World of Warcraft and puts deaths, Bloodlust, and boss encounters " +
    "from the combat log on the video timeline. Windows beta.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="relative flex min-h-full flex-col">{children}</body>
    </html>
  );
}
