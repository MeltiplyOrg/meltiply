# Cloudflare Containers require linux/amd64.
ARG PROCESSOR_PLATFORM=linux/amd64
FROM --platform=${PROCESSOR_PLATFORM} alpine:3.23

RUN apk add --no-cache ca-certificates ffmpeg nodejs vips-tools

ENV NODE_ENV=production \
    PROCESSOR_FFMPEG_THREADS=2 \
    VIPS_CONCURRENCY=2 \
    PROCESSOR_JOB_TIMEOUT_MS=540000 \
    PROCESSOR_MAX_INPUT_BYTES=576716800 \
    PROCESSOR_MAX_OUTPUT_BYTES=536870912 \
    PROCESSOR_MAX_PENDING_JOBS=1 \
    PROCESSOR_PORT=8080 \
    PROCESSOR_WORK_DIR=/tmp/meltiply-processor

WORKDIR /engine
COPY engine/server.mjs engine/engine-job.mjs ./

USER nobody:nobody
EXPOSE 8080

CMD ["node", "/engine/server.mjs"]
