# ksmail-watcher
#
# Built for the Raspberry Pi (arm64), and for anything else Node runs on. There is nothing to install: the watcher has no dependency, so this image is the Node base plus two folders of JavaScript, which is also why it is small and why "docker pull" on a Pi is quick.
#
# Build for the Pi from an Apple Silicon Mac (same architecture, no emulation):
#     docker buildx build --platform linux/arm64 -t ksmail-watcher .
#
FROM node:22-alpine

# tini reaps the process properly and forwards SIGTERM, which is what makes "docker stop" a clean shutdown (the watcher saves its state on the way out) instead of a kill after ten seconds.
RUN apk add --no-cache tini

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src

# KSMAIL_WATCHER_DOCKER tells the commands how this watcher is restarted, and what to say when its configuration is mounted read only.
ENV NODE_ENV=production \
    KSMAIL_WATCHER_CONFIG=/config/config.json \
    KSMAIL_WATCHER_DOCKER=1

# The configuration is mounted read only at /config, the state file is written to /state. Both are volumes on purpose: nothing secret and nothing durable belongs in the image.
VOLUME ["/state"]

# Never root: the watcher opens outgoing sockets and writes one JSON file, and that is all the privilege it should ever have.
USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/bin/ksmail-watcher.js"]
CMD ["run"]
