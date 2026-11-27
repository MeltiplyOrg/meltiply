import { describe, expect, it } from "vite-plus/test";

import { isVideoPath } from "./media";

describe("isVideoPath", () => {
  it.each([
    ["clip.mp4", true],
    ["clip.mov", true],
    ["clip.webm", true],
    ["clip.m4v", true],
    ["CLIP.MP4", true],
    ["cover.png", false],
    ["clip.mp4.png", false],
    ["mp4", false],
    ["", false],
  ])("the path %j", (path, video) => {
    expect(isVideoPath(path)).toEqual(video);
  });
});
