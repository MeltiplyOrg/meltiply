#!/bin/sh
# Generates deterministic media fixtures inside the processor image, using the
# image's own ffmpeg/libvips so the smoke cannot pass on a host that happened
# to ship different binaries. Output is written to the shared object directory
# the fixture service serves.
#
# Usage: make-fixtures.sh <output-dir>
set -eu

out="${1:?usage: make-fixtures.sh <output-dir>}"
mkdir -p "$out"

# ffmpeg in this image cannot write an EXIF orientation tag into a still (it has
# no -write_exif for image output, and -metadata rotate only applies to a video
# display matrix), so the tag is written as the real bytes it is: an EXIF APP1
# segment with a single Orientation entry in IFD0, inserted right after the SOI
# marker, exactly where a camera puts it. libvips reads it back as
# `orientation: 6` and `exif-ifd0-Orientation: 6`, so this is the genuine tag and
# not a stand-in for one.
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

# A large, detailed still image: high-frequency test pattern at a resolution
# and quality that guarantees the optimizer has something to reclaim. The same
# pattern also lets the harness confirm orientation and pixel completeness.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=4000x3000:rate=1,format=rgb24" \
  -frames:v 1 -q:v 2 \
  "$out/photo.jpg"

# Deterministic animations with distinct per-frame content and a measurable
# per-frame delay, so the harness can verify that pacing (not only the frame
# count) survived normalization.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=480x480:rate=10,format=rgb24" \
  -t 2 \
  "$out/animation.gif"

# The same animation as an animated WebP, written by libvips rather than FFmpeg:
# FFmpeg cannot decode an animated WebP in this image at all ("image data not
# found"), so an FFmpeg-produced fixture could not be measured by anything. libvips
# keeps every frame, the alpha band and the per-frame delays, and is the encoder the
# engine itself uses for animated WebP renditions.
vips copy "$out/animation.gif[n=-1]" "$out/animation.webp[Q=90,effort=4]"

# The same animation as a real APNG: FFmpeg's apng encoder writes the acTL/fcTL
# chunks, so the fixture carries a genuine animation control block, per-frame
# delays and a play count — not a renamed GIF. libvips can only read its first
# frame, which is exactly the decoder gap the engine's APNG path must route
# around without dropping the animation.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=480x480:rate=10,format=rgba" \
  -t 2 -c:v apng -f apng -plays 0 \
  "$out/animation.png"

# Verifies a generated animation's decoded alpha band really spans the range
# the fixtures promise, inside generation itself: a fixture that is opaque when
# it claims transparency — or vice versa — must fail loudly here rather than be
# discovered as a checker failure twenty minutes into a container run. The
# alpha plane is decoded to raw bytes and scanned as a stream, so the check
# costs memory of one pipe, not one animation.
# Usage: assert_alpha_range <file> <expected-min> <expected-max>
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

# A second APNG that carries *meaningful* transparency: the pattern is converted
# to planar RGBA (gbrap) and `geq` writes the alpha plane directly per frame —
# unlike drawbox or overlay, which composite in a non-alpha working space and
# measurably flatten the channel — so the left half of every frame decodes at
# alpha 0 while the right half keeps the pattern at 255. The companion
# animation.png is fully opaque RGBA, which is the case an alpha channel's mere
# presence would get wrong — a real measurement has to say "this one has no
# transparent pixels" or a valid rendition is rejected. Both fixtures are
# alpha-proven immediately after encoding, so a recipe regression fails here.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=480x480:rate=10,format=rgba" \
  -t 2 -vf "format=gbrap,geq=a='if(lt(X,240),0,255)':r='r(X,Y)':g='g(X,Y)':b='b(X,Y)',format=rgba" \
  -c:v apng -f apng -plays 0 \
  "$out/animation-alpha.png"

assert_alpha_range "$out/animation-alpha.png" 0 255
assert_alpha_range "$out/animation.png" 255 255

# A tall animation whose frames overflow a 2048 height bound while their width
# stays far inside it: the frame is scaled on the axis that actually overflows,
# which a width-only fit check would silently skip.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=48x2600:rate=10,format=rgb24" \
  -t 1 \
  "$out/.tall-animation.gif"
vips copy "$out/.tall-animation.gif[n=-1]" "$out/tall-animation.webp[Q=90,effort=4]"
rm -f "$out/.tall-animation.gif"

# A thin, wide animation whose scale factor lands on a non-integer frame
# height: at half size 8192x203 becomes 4096x101.5, which is 4096x102 on the
# nearest-integer grid but 4096x100 on an even-pixel grid. Encoder and verifier
# must agree on that grid or the rendition is discarded as never written.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=8192x203:rate=10,format=rgb24" \
  -t 1 \
  "$out/.thin-animation.gif"
vips copy "$out/.thin-animation.gif[n=-1]" "$out/thin-animation.webp[Q=90,effort=4]"
rm -f "$out/.thin-animation.gif"

# A compliant H.264/AAC MP4 padded with a large removable metadata comment: the
# stream is already browser-ready, so only dropping the container padding is an
# improvement, and a lossless remux must win that way rather than through a
# lossy re-encode. The padding value is written to a metadata file and handed to
# ffmpeg with `-/metadata`, because a 4 MiB value cannot be passed as one argv
# element on Linux (MAX_ARG_STRLEN caps a single argument at 128 KiB).
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

# A short normalized video: well under every platform and transformation
# ceiling, used both as an ordinary optimization subject and as the input for
# the no-benefit path after the engine produces a compliant rendition.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 8 -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k -movflags +faststart \
  "$out/short.mp4"

# A large QuickTime/MP4 source that is deliberately beyond the short-video
# transformation service's limits (over 100 MB input and over 60 s output)
# while staying inside the 500 MiB upload policy. Lossless detail-heavy
# content keeps the source large so the optimizer has a real improvement to
# prove; the audio track must survive into the rendition.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -t 65 -c:v libx264 -preset ultrafast -qp 0 -c:a aac -b:a 192k \
  "$out/long.mp4"

# The same content in a QuickTime wrapper, so the engine must normalize the
# container as well as the streams and keep the audio and duration intact.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -t 70 -c:v libx264 -preset ultrafast -qp 0 -c:a aac -b:a 192k -f mov \
  "$out/long.mov"

# A 10-bit H.264 source: a real `yuv420p10le` stream, which is not browser-ready,
# so the engine cannot report it as original_compatible and must produce a
# re-encoded 8-bit 4:2:0 AAC rendition even when that rendition is not smaller.
# The proof is in the uploaded bytes, not the engine's report.
ffmpeg -v error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30,format=yuv420p10le" \
  -f lavfi -i "sine=frequency=550:sample_rate=48000" \
  -t 4 -c:v libx264 -preset veryfast -profile:v high10 -crf 24 -c:a aac -b:a 128k -movflags +faststart \
  "$out/high10.mp4"

# A still image with real, partial transparency: a fully transparent 1600x1200
# canvas with an opaque test pattern covering only its centre, so the decoded
# alpha band spans 0..255 instead of being all opaque behind a fourth channel.
# The companion RGBA frame is fully opaque. Under the JPEG-first smoke profile
# the transparent one must never be flattened into JPEG, while the opaque one is
# a legitimate JPEG subject: transparency decides, not the arrival container.
# The alpha mask is built with libvips rather than an ffmpeg overlay: overlay
# negotiates its output format and hands back a fully opaque image here, which
# is exactly the case this fixture has to rule out. An all-zero single-band mask
# painted opaque over the pattern's own area is joined as the alpha channel, so
# the decoded alpha band really spans 0..255.
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

# A portrait photograph carrying a genuine EXIF Orientation=6 tag, which libvips
# resolves as `orientation: 6` and as a transpose on autorot. The engine must
# bake that rotation into the pixels: stripping the tag without turning the image
# would silently present the creator's portrait as a landscape one.
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

# Anamorphic sources: the non-square sample aspect ratio is stored by the MP4
# muxer in the track's pasp box, so ffprobe reports a real "15:16" rather than
# "1:1". 1280x720 at 15:16 displays as 1200x720 and already fits the smoke
# profile bounds, while the HD frame is beyond them, so square pixel
# normalization is proven both unchanged and combined with downscaling.
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
