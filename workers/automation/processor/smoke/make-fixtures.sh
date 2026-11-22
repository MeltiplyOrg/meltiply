#!/bin/sh
set -eu

out="${1:?usage: make-fixtures.sh <output-dir>}"
mkdir -p "$out"

# ffmpeg cannot write an EXIF orientation tag into a still, so the APP1 segment
# is written directly.
exif_injector="${TMPDIR:-/tmp}/meltiply-exif-orientation.mjs"
cat >"$exif_injector" <<'EXIF_INJECTOR'
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, raw] = process.argv.slice(2);
const orientation = Number(raw);
if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
  throw new Error("orientation must be an integer 1..8");
}
const jpeg = readFileSync(input);
if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error(`not a JPEG: ${input}`);
// APP1 / "Exif\0\0" / little-endian TIFF header / IFD0 with one SHORT entry /
// no next IFD. The entry's value is left-aligned in its four-byte field.
const app1 = Buffer.from([
  0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00,
  0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
  orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
writeFileSync(output, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
EXIF_INJECTOR

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=4000x3000:rate=1,format=rgb24" \
  -frames:v 1 -q:v 2 \
  "$out/photo.jpg"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=480x480:rate=10,format=rgb24" \
  -t 2 \
  "$out/animation.gif"

# FFmpeg cannot decode animated WebP ("image data not found").
vips copy "$out/animation.gif[n=-1]" "$out/animation.webp[Q=90,effort=4]"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=480x480:rate=10,format=rgba" \
  -t 2 -c:v apng -f apng -plays 0 \
  "$out/animation.png"

assert_alpha_range() {
  ffmpeg -v error -xerror -nostdin -y -i "$1" -vf alphaextract -f rawvideo -pix_fmt gray "$1.alpha.raw"
  node - "$1.alpha.raw" "$2" "$3" <<'ALPHA_SCAN'
const fs = require("node:fs");
let min = 255, max = 0;
for (const byte of fs.readFileSync(process.argv[2])) {
  if (byte < min) min = byte;
  if (byte > max) max = byte;
}
const wantMin = Number(process.argv[3]), wantMax = Number(process.argv[4]);
if (min !== wantMin || max !== wantMax) {
  console.error(`assert_alpha_range: decoded alpha ${min}..${max}, expected ${wantMin}..${wantMax}`);
  process.exit(1);
}
ALPHA_SCAN
  rm -f "$1.alpha.raw"
}

# ffmpeg's drawbox and overlay composite in a non-alpha working space and flatten
# the channel; geq on gbrap writes alpha directly.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=480x480:rate=10,format=rgba" \
  -t 2 -vf "format=gbrap,geq=a='if(lt(X,240),0,255)':r='r(X,Y)':g='g(X,Y)':b='b(X,Y)',format=rgba" \
  -c:v apng -f apng -plays 0 \
  "$out/animation-alpha.png"

assert_alpha_range "$out/animation-alpha.png" 0 255
assert_alpha_range "$out/animation.png" 255 255

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=48x2600:rate=10,format=rgb24" \
  -t 1 \
  "$out/.tall-animation.gif"
vips copy "$out/.tall-animation.gif[n=-1]" "$out/tall-animation.webp[Q=90,effort=4]"
rm -f "$out/.tall-animation.gif"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=8192x203:rate=10,format=rgb24" \
  -t 1 \
  "$out/.thin-animation.gif"
vips copy "$out/.thin-animation.gif[n=-1]" "$out/thin-animation.webp[Q=90,effort=4]"
rm -f "$out/.thin-animation.gif"

# Linux MAX_ARG_STRLEN caps one argv element at 128 KiB.
node -e '
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[1], `comment=${"m".repeat(4 * 1024 * 1024)}\n`);
' "$out/.bloated-metadata.txt"
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000" \
  -t 3 -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k \
  -/metadata "$out/.bloated-metadata.txt" -movflags +faststart \
  "$out/bloated.mp4"
rm -f "$out/.bloated-metadata.txt"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 8 -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k -movflags +faststart \
  "$out/short.mp4"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -t 65 -c:v libx264 -preset ultrafast -qp 0 -c:a aac -b:a 192k \
  "$out/long.mp4"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -t 70 -c:v libx264 -preset ultrafast -qp 0 -c:a aac -b:a 192k -f mov \
  "$out/long.mov"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30,format=yuv420p10le" \
  -f lavfi -i "sine=frequency=550:sample_rate=48000" \
  -t 4 -c:v libx264 -preset veryfast -profile:v high10 -crf 24 -c:a aac -b:a 128k -movflags +faststart \
  "$out/high10.mp4"

# ffmpeg's overlay negotiates an opaque output format here, so libvips builds the
# alpha mask.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1600x1200:rate=1,format=rgb24" \
  -frames:v 1 \
  "$out/.alpha-pattern.png"
vips copy "$out/.alpha-pattern.png" "$out/.alpha-pattern.v"
vips extract_band "$out/.alpha-pattern.v" "$out/.alpha-grey.v" 1
vips linear "$out/.alpha-grey.v" "$out/.alpha-mask.v" 0 0
vips draw_rect "$out/.alpha-mask.v" 255 400 300 800 600 --fill=true
vips bandjoin "$out/.alpha-pattern.v $out/.alpha-mask.v" "$out/photo-alpha.png[compression=9]"
rm -f "$out/.alpha-pattern.png" "$out/.alpha-pattern.v" "$out/.alpha-grey.v" "$out/.alpha-mask.v"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=3000x4000:rate=1,format=rgb24" \
  -frames:v 1 -q:v 2 \
  "$out/.oriented.jpg"
node "$exif_injector" "$out/.oriented.jpg" "$out/oriented.jpg" 6
rm -f "$out/.oriented.jpg"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1600x1200:rate=1,format=rgba" \
  -frames:v 1 \
  "$out/photo-opaque.png"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 4 -vf "setsar=15/16" -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k -movflags +faststart \
  "$out/anamorphic.mp4"

ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=2560x1440:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 3 -vf "setsar=15/16" -c:v libx264 -preset veryfast -crf 24 -c:a aac -b:a 128k -movflags +faststart \
  "$out/anamorphic-hd.mp4"

ls -l "$out"
