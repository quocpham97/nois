import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: serve dev assets to 127.0.0.1 too (localhost is the canonical
  // origin), so a second signed-in identity can be tested from the same
  // browser without its cookies colliding with localhost's.
  allowedDevOrigins: ["127.0.0.1"],
  // Conversations used to route under /c/<id> (groups) and /dm/<key> (DMs, with
  // a "dm-" id prefix); they now all live at the root as /<id>. Redirect the old
  // shapes so existing links/bookmarks keep working. Order matters — the more
  // specific /c/dm-… rule must precede the general /c/… one.
  async redirects() {
    return [
      { source: "/c/dm-:key", destination: "/:key", permanent: true },
      { source: "/c/:id", destination: "/:id", permanent: true },
      { source: "/dm/:key", destination: "/:key", permanent: true },
    ];
  },
};

export default nextConfig;
