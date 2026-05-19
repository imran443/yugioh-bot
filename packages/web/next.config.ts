import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@yugidraft/shared"],
  serverExternalPackages: ["better-sqlite3", "sharp"],
  images: {
    // Card art is immutable — cache optimized variants for a year instead of
    // the 60s default so previews stay warm. WebP only: AVIF's slower cold
    // encode is exactly the cold-start cost we are trying to reduce.
    minimumCacheTTL: 31536000,
    formats: ["image/webp"],
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
