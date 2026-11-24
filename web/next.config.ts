import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use the contributor guide at the repository root.
  agentRules: false,
  // Cloudflare Pages serves the export without a Next.js server.
  output: "export",
  images: { unoptimized: true },
  turbopack: {
    // Keep module resolution inside web/ instead of using the desktop lockfile.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
