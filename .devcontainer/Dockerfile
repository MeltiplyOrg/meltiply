FROM node:24.18.0-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq make sudo unzip iproute2 procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global bun@1.4.2 \
    && printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

USER node
