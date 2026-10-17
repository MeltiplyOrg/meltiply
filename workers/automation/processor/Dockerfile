# Native media processor image (issue #284).
#
# Cloudflare Containers require linux/amd64, which remains the default even on
# ARM workstations. Self-hosting and native smoke fixture helpers override
# PROCESSOR_PLATFORM to run the same pinned codecs natively on ARM64 too.
#
# Alpine 3.23 provides the native engines this feature requires: ffmpeg 8.x
# (ffmpeg + ffprobe) for full decode, duration, frame and audio verification and
# H.264/AAC normalization, and libvips 8.17 (vips, vipsheader) for image
# re-encoding, transparency detection and full pixel decode. Node runs the small
# private HTTP service that receives jobs from the Durable Object binding.
ARG PROCESSOR_PLATFORM=linux/amd64
FROM --platform=${PROCESSOR_PLATFORM} alpine:3.23

# ffmpeg/ffprobe: decode + normalize video and animations.
# vips/vipsheader: still-image re-encoding and transparency detection.
# nodejs: the job service. ca-certificates: TLS egress to object storage.
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
COPY engine/server.mjs ./server.mjs

# The engine writes only under its own work directory, so it needs no root
# privileges; /tmp is writable by any user in the base image.
USER nobody:nobody
EXPOSE 8080

# PROCESSOR_JOB_TOKEN is injected by the Durable Object at container start and
# is intentionally absent here: an engine without it must refuse to boot rather
# than accept unauthenticated jobs.
CMD ["node", "/engine/server.mjs"]
