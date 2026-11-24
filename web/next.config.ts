import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use the contributor guide at the repository root.
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
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
