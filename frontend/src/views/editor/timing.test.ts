import { describe, expect, test } from "bun:test";
import { timelinePercent, timingProblem, withDuration, withEnd, withStart } from "./timing";

describe("withStart", () => {
    const timing = { start: 10, end: 20, duration: 100 };

    test("moves the start and rounds to the millisecond", () => {
        expect(withStart(timing, 12.34567)).toEqual({ start: 12.346, end: 20, duration: 100 });
    });

    test("stays inside the video", () => {
        expect(withStart(timing, -5).start).toBe(0);
    });

    test("pushes the end along, keeping the clip length", () => {
        expect(withStart(timing, 50)).toEqual({ start: 50, end: 60, duration: 100 });
    });

    test("backs off when the end hits the end of the video", () => {
        expect(withStart(timing, 100)).toEqual({ start: 90, end: 100, duration: 100 });
    });

    test("works while the video length is unknown", () => {
        expect(withStart({ start: 0, end: 0, duration: 0 }, 42)).toEqual({ start: 41, end: 42, duration: 0 });
        expect(withStart({ start: 0, end: 5, duration: 0 }, -1).start).toBe(0);
    });
});

describe("withEnd", () => {
    const timing = { start: 10, end: 20, duration: 100 };

    test("moves the end", () => {
        expect(withEnd(timing, 30.5)).toEqual({ start: 10, end: 30.5, duration: 100 });
        expect(withEnd(timing, 500).end).toBe(100);
    });

    test("pushes the start along, keeping the clip length", () => {
        expect(withEnd(timing, 5)).toEqual({ start: 0, end: 5, duration: 100 });
        expect(withEnd({ start: 50, end: 60, duration: 100 }, 40)).toEqual({ start: 30, end: 40, duration: 100 });
    });

    test("backs off when the start hits the beginning", () => {
        expect(withEnd(timing, 0)).toEqual({ start: 0, end: 10, duration: 100 });
    });
});

describe("withDuration", () => {
    test("pulls the selection back inside a shorter version", () => {
        expect(withDuration({ start: 80, end: 95, duration: 100 }, 90)).toEqual({ start: 80, end: 90, duration: 90 });
    });

    test("keeps the old length when the new version does not report one", () => {
        const timing = { start: 10, end: 20, duration: 100 };
        expect(withDuration(timing, null)).toEqual(timing);
    });
});

test("timingProblem", () => {
    expect(timingProblem({ start: 0, end: 30, duration: 100 }, 600)).toBe("");
    expect(timingProblem({ start: 0, end: 0.4, duration: 100 }, 600)).toBe("short");
    expect(timingProblem({ start: 0, end: 601, duration: 1000 }, 600)).toBe("long");
    expect(timingProblem({ start: 0, end: 600, duration: 1000 }, 600)).toBe("");
    // 0 means there is no limit.
    expect(timingProblem({ start: 0, end: 5000, duration: 9000 }, 0)).toBe("");
});

test("timelinePercent", () => {
    expect(timelinePercent(25, 100)).toBe("25%");
    expect(timelinePercent(150, 100)).toBe("100%");
    expect(timelinePercent(10, 0)).toBe("0%");
});
