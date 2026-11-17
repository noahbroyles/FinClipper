import { describe, expect, test } from "bun:test";
import { clamp, classes, fmtBytes, fmtRuntime, fmtTime, parseTime } from "./format";

describe("fmtTime", () => {
    test("formats hours, minutes, seconds and milliseconds", () => {
        expect(fmtTime(83.5)).toBe("00:01:23.500");
        expect(fmtTime(3723.042)).toBe("01:02:03.042");
    });

    test("can leave out the milliseconds", () => {
        expect(fmtTime(83.5, false)).toBe("00:01:23");
    });

    test("rounds to the millisecond and never goes below zero", () => {
        expect(fmtTime(0.9996)).toBe("00:00:01.000");
        expect(fmtTime(-5)).toBe("00:00:00.000");
    });
});

describe("parseTime", () => {
    test("accepts seconds, MM:SS and HH:MM:SS", () => {
        expect(parseTime("12.5")).toBe(12.5);
        expect(parseTime("1:23")).toBe(83);
        expect(parseTime("01:02:03.250")).toBe(3723.25);
        expect(parseTime("  90  ")).toBe(90);
    });

    test("plain seconds may exceed a minute, but not after a colon", () => {
        expect(parseTime("90")).toBe(90);
        expect(parseTime("1:60")).toBeNaN();
        expect(parseTime("1:60:00")).toBeNaN();
        // Minutes without hours are not limited.
        expect(parseTime("90:00")).toBe(5400);
    });

    test("rejects anything else", () => {
        for (const text of ["", "abc", "1:2:3:4", "-5", "1:", "1.5:00", "1,5"]) {
            expect(parseTime(text)).toBeNaN();
        }
    });

    test("reads back what fmtTime writes", () => {
        for (const seconds of [0, 0.001, 59.999, 60, 3599.5, 7384.125]) {
            expect(parseTime(fmtTime(seconds))).toBe(seconds);
        }
    });
});

test("fmtRuntime", () => {
    expect(fmtRuntime(7384)).toBe("2h 3m");
    expect(fmtRuntime(95)).toBe("1m 35s");
    expect(fmtRuntime(120)).toBe("2m");
    expect(fmtRuntime(42.7)).toBe("42s");
    expect(fmtRuntime(0)).toBe("");
    expect(fmtRuntime(null)).toBe("");
});

test("fmtBytes", () => {
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
});

test("clamp", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
});

test("classes skips names that are switched off", () => {
    expect(classes("a", false, "b", null, undefined, "")).toBe("a b");
});
