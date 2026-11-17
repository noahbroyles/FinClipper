import { expect, test } from "bun:test";
import { cropRect } from "./crop";

test("the narrowest crop of a 16:9 picture is a 9:16 slice of its full height", () => {
    expect(cropRect(1920, 1080, 0.5, 0)).toEqual({ left: 656.25, top: 0, width: 607.5, height: 1080 });
});

test("cropX slides the area from the left edge to the right edge", () => {
    expect(cropRect(1920, 1080, 0, 0).left).toBe(0);
    expect(cropRect(1920, 1080, 1, 0).left).toBe(1920 - 607.5);
});

test("cropWidth widens the area up to the whole picture", () => {
    const half = cropRect(1920, 1080, 0.5, 0.5);
    expect(half.width).toBe(607.5 + (1920 - 607.5) / 2);
    expect(half.left).toBe((1920 - half.width) / 2);
    expect(half.height).toBe(1080);
    expect(cropRect(1920, 1080, 0.3, 1)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
});

test("a picture taller than 9:16 keeps its width and loses top and bottom", () => {
    expect(cropRect(900, 2000, 0.5, 0)).toEqual({ left: 0, top: 200, width: 900, height: 1600 });
    // There is nothing to widen.
    expect(cropRect(900, 2000, 0.5, 1)).toEqual({ left: 0, top: 200, width: 900, height: 1600 });
});
