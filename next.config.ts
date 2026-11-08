import type { NextConfig } from "next";

// Mission covers (D-146): this project's public cover bucket and nothing else.
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL)
  : null;

const nextConfig: NextConfig = {
  async redirects() {
    const academyHome = "/academy/my-missions";
    return [
      { source: "/", destination: academyHome, permanent: false },
      { source: "/about", destination: academyHome, permanent: false },
      { source: "/labs", destination: academyHome, permanent: false },
      { source: "/journal", destination: academyHome, permanent: false },
      { source: "/missions/:path*", destination: academyHome, permanent: false },
    ];
  },
  images: {
    remotePatterns: supabase
      ? [
          {
            protocol: supabase.protocol === "http:" ? "http" : "https",
            hostname: supabase.hostname,
            port: supabase.port,
            pathname: "/storage/v1/object/public/mission-covers/**",
          },
        ]
      : [],
    // The local Supabase is on a loopback address, which Next refuses to fetch
    // by default. `next dev` only: production keeps that protection.
    ...(process.env.NODE_ENV === "development" ? { dangerouslyAllowLocalIP: true } : {}),
  },
  // Printables embed WLA's typefaces (Karla, Fraunces; SIL OFL — see
  // assets/fonts). They are read from disk by the print route and by mission
  // QA's test render, so the deployment bundle must carry them.
  outputFileTracingIncludes: {
    "/api/print/**": ["./assets/fonts/**"],
    "/admin/builder/**": ["./assets/fonts/**"],
  },
};

export default nextConfig;
