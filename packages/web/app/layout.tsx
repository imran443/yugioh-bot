import type { Metadata } from "next";
import { Russo_One, Chakra_Petch } from "next/font/google";
import { AppShell } from "@/components/layout/app-shell";
import "./globals.css";

const russoOne = Russo_One({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-russo-one",
});

const chakraPetch = Chakra_Petch({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-chakra-petch",
});

export const metadata: Metadata = {
  title: "Yu-Gi-Oh! Tournament Manager",
  description: "Manage your Yu-Gi-Oh! tournaments with ease",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${russoOne.variable} ${chakraPetch.variable} dark`}>
      <body className="min-h-screen bg-bg-deep text-text-primary antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
