# The image every Node build of a project runs in (docs/phase8b-plan.md, "A build"): Node LTS,
# git, the tools native packages need (python3, make, g++), and pnpm installed with npm
# (Q-J4: npm and pnpm; not Corepack, which fetches pnpm's binary on first use and is gone
# from Node 25). Built by install-projects.sh as svc-lfdln-apps, tagged
# localhost/lfdln-build-node:current. Runs as node (uid 1000 inside), never root.
FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@latest && npm cache clean --force
COPY lfdln-build-versions /usr/local/bin/lfdln-build-versions
USER node
WORKDIR /work
