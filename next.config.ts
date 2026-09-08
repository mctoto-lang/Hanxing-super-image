import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // dev 下放行 localhost / 127.0.0.1 两种访问方式，避免 HMR 与静态资源被跨域拦截
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  experimental: {
    // proxy.ts 克隆缓冲请求体的上限（默认 10MB）。
    // /api/upload 允许 ≤20MB 图片，超 10MB 会被截断成损坏的 FormData，故提到 25MB；
    // PSD 上传（≤300MB）已从 proxy matcher 排除，不走这层缓冲。
    proxyClientMaxBodySize: "25mb",
  },
};

export default nextConfig;
