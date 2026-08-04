import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // ファイル添付の既定上限20MB（§3.8）に合わせ、Server Actionのボディ上限を拡張
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
