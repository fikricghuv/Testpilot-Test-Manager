import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import BetterBugsWidget from "@/components/BetterBugsWidget";
import PostHogIdentify from "@/components/PostHogIdentify";

const inter = localFont({
  src: "../public/fonts/inter-variable.woff2",
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "../public/fonts/jetbrains-mono-variable.woff2",
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TestPilot Test Manager",
  description: "AI-Powered Test Case Management",
  icons: {
    icon: [
      { url: "/brand/testpilot-logo-light.svg", type: "image/svg+xml" },
    ],
  },
};

const themeInitScript = `
  (() => {
    try {
      const storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
      const savedTheme = window.localStorage.getItem(storageKey);
      const theme = savedTheme === "dark" ? "dark" : "light";
      const root = document.documentElement;
      root.classList.toggle("dark", theme === "dark");
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    } catch {
      const root = document.documentElement;
      root.classList.remove("dark");
      root.dataset.theme = "light";
      root.style.colorScheme = "light";
    }
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        {children}
        <BetterBugsWidget />
        <PostHogIdentify />
      </body>
    </html>
  );
}
