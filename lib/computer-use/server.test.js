import { describe, expect, it } from "vitest";
import { __computerUseInternals } from "./server.js";

const {
  normalizeDisplayList,
  resolveDisplaySpecifier,
  resolveCoordinateInGlobalSpace,
} = __computerUseInternals;

describe("computer_use display coordinate mapping", () => {
  it("uses screencapture display numbers separately from CG display ids", () => {
    const displays = normalizeDisplayList([
      {
        displayId: 2,
        width: 2560,
        height: 1440,
        pointWidth: 2560,
        pointHeight: 1440,
        originX: 0,
        originY: 0,
        isMain: true,
      },
      {
        displayId: 1,
        width: 1470,
        height: 956,
        pointWidth: 1470,
        pointHeight: 956,
        originX: -1470,
        originY: 484,
        isMain: false,
      },
    ]);

    expect(displays[0]).toMatchObject({
      displayId: 2,
      captureDisplayNumber: 1,
      name: "Main display (display 1, id 2)",
    });
    expect(displays[1]).toMatchObject({
      displayId: 1,
      captureDisplayNumber: 2,
      name: "Secondary display 1 (display 2, id 1)",
    });

    expect(resolveDisplaySpecifier(displays, "2")).toBe(displays[1]);
    expect(resolveDisplaySpecifier(displays, "display 2")).toBe(displays[1]);
    expect(resolveDisplaySpecifier(displays, "id:2")).toBe(displays[0]);
    expect(resolveDisplaySpecifier(displays, "main")).toBe(displays[0]);
  });

  it("maps screenshot-local pixels into the selected display global coordinate space", () => {
    const state = {
      lastScreenshot: {
        width: 1470,
        height: 956,
        displayId: 1,
        captureDisplayNumber: 2,
        originX: -1470,
        originY: 484,
        pointWidth: 1470,
        pointHeight: 956,
        pixelWidth: 1470,
        pixelHeight: 956,
        regionX: 0,
        regionY: 0,
      },
    };

    expect(resolveCoordinateInGlobalSpace(state, [100, 50])).toMatchObject({
      x: -1370,
      y: 534,
      mapped: true,
      displayId: 1,
    });
  });

  it("maps Retina screenshot pixels back to point-based CG event coordinates", () => {
    const state = {
      lastScreenshot: {
        width: 3024,
        height: 1964,
        displayId: 7,
        captureDisplayNumber: 1,
        originX: 0,
        originY: 0,
        pointWidth: 1512,
        pointHeight: 982,
        pixelWidth: 3024,
        pixelHeight: 1964,
        regionX: 0,
        regionY: 0,
      },
    };

    expect(resolveCoordinateInGlobalSpace(state, [3024, 1964])).toMatchObject({
      x: 1512,
      y: 982,
      mapped: true,
      displayId: 7,
    });
  });
});
