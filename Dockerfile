FROM node:22-alpine
WORKDIR /app

# Build-gate toolchains ---------------------------------------------------
# git:         shallow clones of the feature branch for the build gate
# python3:     runtime for pyright (Python build gate)
# dotnet8-sdk: C#/Unity build gate, from the edge community repo. Optional:
#              if it can't be installed the C# gate is skipped, nothing else.
RUN apk add --no-cache git python3 \
    && (apk add --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/edge/community dotnet8-sdk \
        || echo "dotnet SDK unavailable; the C#/Unity build gate will be skipped")

# pyright: Python type checker used by the build gate.
RUN npm install -g pyright pnpm@10.14.0 && npm cache clean --force

# Dependencies first so the layer caches across source-only changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Runtime state lives in /app/data (sessions, channel->repo bindings, usage log).
# Mount a volume there to keep it across redeploys (see docker-compose.yml).
RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
