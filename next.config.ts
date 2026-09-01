import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // dev 下放行 localhost / 127.0.0.1 两种访问方式，避免 HMR 与静态资源被跨域拦截
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
