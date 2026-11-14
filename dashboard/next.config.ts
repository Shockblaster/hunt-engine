import type { NextConfig } from "next";
import { join } from "node:path";

// A local, single-user dashboard over a live SQLite file: every page renders fresh on each request.
const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: [],
  turbopack: {
    root: join(__dirname, ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
