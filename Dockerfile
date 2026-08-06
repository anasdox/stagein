# Single image, two roles: the relay and the Norns simulator share the
# workspace, so `docker compose` runs the same build as `mise run dev`.
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

# Manifests and the lockfile first, so dependency installation caches
# independently of sources — and so the build is reproducible.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
COPY packages/norns-sim/package.json packages/norns-sim/

# --frozen-lockfile makes the image a function of the committed lockfile: an
# unrelated upstream release can never change what ships.
# --no-optional skips easymidi: real MIDI ports need native bindings and a
# soundcard, neither of which exists in a container. The simulator falls back
# to its log/OSC backends.
RUN pnpm install --frozen-lockfile --no-optional

COPY packages/ packages/
RUN pnpm -r build


FROM node:22-alpine AS runtime

RUN apk add --no-cache curl tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY --from=build /app/packages/relay/public ./packages/relay/public
COPY --from=build /app/packages/relay/package.json ./packages/relay/package.json
COPY --from=build /app/packages/relay/node_modules ./packages/relay/node_modules
COPY --from=build /app/packages/norns-sim/dist ./packages/norns-sim/dist
COPY --from=build /app/packages/norns-sim/lua ./packages/norns-sim/lua
# The engine the simulator executes is the deployable one, not a copy.
COPY --from=build /app/packages/norns-script/lib ./packages/norns-script/lib
COPY --from=build /app/packages/norns-sim/public ./packages/norns-sim/public
COPY --from=build /app/packages/norns-sim/package.json ./packages/norns-sim/package.json
COPY --from=build /app/packages/norns-sim/node_modules ./packages/norns-sim/node_modules

# Owned before the volume is created, so the MIDI journal is writable as `node`.
RUN mkdir -p /data && chown node:node /data

USER node
# tini reaps properly so SIGTERM reaches Node and both services can fail safe.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/relay/dist/index.js"]
