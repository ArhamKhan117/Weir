import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` otherwise writes its own AGENTS.md and CLAUDE.md here whenever it sees a coding
  // agent; the repository's root CLAUDE.md is the one project memory.
  agentRules: false,
};

export default nextConfig;
