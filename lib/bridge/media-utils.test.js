import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setMediaLocalRoots, splitMediaFromOutput } from "./media-utils.js";

describe("splitMediaFromOutput media-tag parsing", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-media-test-"));
    let real = tempDir;
    try { real = fs.realpathSync(tempDir); } catch {}
    setMediaLocalRoots([tempDir, real]);
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    setMediaLocalRoots([]);
  });

  it("extracts multiple MEDIA lines inside one <media> block", () => {
    const p1 = path.join(tempDir, "a.png");
    const p2 = path.join(tempDir, "b.png");
    fs.writeFileSync(p1, "x");
    fs.writeFileSync(p2, "y");

    const text = `<media>
MEDIA:${p1}
MEDIA:${p2}
</media>`;

    const out = splitMediaFromOutput(text);
    expect(out.text).toBe("");
    expect(out.mediaUrls).toEqual([p1, p2]);
    expect(out.mediaErrors).toEqual([]);
  });

  it("extracts bare media sources line-by-line inside <media> block", () => {
    const url1 = "https://example.com/a.png";
    const url2 = "https://example.com/b.jpg";
    const text = `<media>
${url1}
${url2}
</media>`;

    const out = splitMediaFromOutput(text);
    expect(out.text).toBe("");
    expect(out.mediaUrls).toEqual([url1, url2]);
    expect(out.mediaErrors).toEqual([]);
  });
});
