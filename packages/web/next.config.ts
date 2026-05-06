import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@yugidraft/shared"],
  serverExternalPackages: ["better-sqlite3", "sharp"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.ygoprodeck.com",
        pathname: "/images/cards/**",
      },
      {
        protocol: "https",
        hostname: "images.ygoprodeck.com",
        pathname: "/images/cards_small/**",
      },
    ],
  },
};

export default nextConfig;
