import { describe, expect, test } from "bun:test";
import {
    initialParts,
    partsProblem,
    selectedTiming,
    totalLength,
    withFoundDuration,
    withPartAdded,
    withPartMoved,
    withPartRemoved,
    withSelectedCrop,
    withSelectedEnd,
    withSelectedStart,
    withSelection,
    withVideoDuration,
    type ClipParts,
} from "./parts";

// Three parts of a 100 s video; the second is selected.
function three(): ClipParts {
    return {
        list: [
            { id: 1, start: 10, end: 20, cropX: 0.5, cropWidth: 0.35 },
            { id: 2, start: 50, end: 55, cropX: 0.2, cropWidth: 0 },
            { id: 3, start: 30, end: 31, cropX: 0.8, cropWidth: 1 },
        ],
        selected: 1,
        duration: 100,
    };
}

const ids = (parts: ClipParts) => parts.list.map((part) => part.id);

test("a new video has one part: its first 30 seconds, with the default crop", () => {
    expect(initialParts(600)).toEqual({
        list: [{ id: 1, start: 0, end: 30, cropX: 0.5, cropWidth: 0.35 }],
        selected: 0,
        duration: 600,
    });
    expect(initialParts(12).list[0]?.end).toBe(12);
});

describe("editing the selected part", () => {
    test("start and end move only that part", () => {
        const moved = withSelectedEnd(withSelectedStart(three(), 51), 58.5);
        expect(moved.list[1]).toEqual({ id: 2, start: 51, end: 58.5, cropX: 0.2, cropWidth: 0 });
        expect(moved.list[0]).toEqual(three().list[0]);
        expect(moved.list[2]).toEqual(three().list[2]);
    });

    test("a start past the end pushes the end along, inside the video", () => {
        expect(withSelectedStart(three(), 70).list[1]).toMatchObject({ start: 70, end: 75 });
        expect(withSelectedStart(three(), 98).list[1]).toMatchObject({ start: 98, end: 100 });
    });

    test("the crop belongs to the part", () => {
        const cropped = withSelectedCrop(three(), { cropX: 0.9 });
        expect(cropped.list[1]).toMatchObject({ cropX: 0.9, cropWidth: 0 });
        expect(cropped.list[0]).toMatchObject({ cropX: 0.5, cropWidth: 0.35 });
    });

    test("selectedTiming is the selected part with the video's length", () => {
        expect(selectedTiming(three())).toEqual({ start: 50, end: 55, duration: 100 });
        expect(selectedTiming(withSelection(three(), 2))).toEqual({ start: 30, end: 31, duration: 100 });
    });

    test("the selection stays inside the list", () => {
        expect(withSelection(three(), 7).selected).toBe(2);
        expect(withSelection(three(), -1).selected).toBe(0);
    });
});

describe("withPartAdded", () => {
    test("adds ten seconds from the playhead, played last, selected and framed like the selected part", () => {
        const added = withPartAdded(three(), 70.1234);
        expect(added.list).toHaveLength(4);
        expect(added.list[3]).toEqual({ id: 4, start: 70.123, end: 80.123, cropX: 0.2, cropWidth: 0 });
        expect(added.selected).toBe(3);
    });

    test("stops at the end of the video", () => {
        expect(withPartAdded(three(), 96).list[3]).toMatchObject({ start: 96, end: 100 });
    });

    test("reaches back when the playhead is at the very end", () => {
        expect(withPartAdded(three(), 100).list[3]).toMatchObject({ start: 90, end: 100 });
        // A video shorter than a new part.
        const short = withPartAdded(initialParts(4), 4);
        expect(short.list[1]).toMatchObject({ start: 0, end: 4 });
    });

    test("works while the video length is unknown", () => {
        expect(withPartAdded(initialParts(0), 42).list[1]).toMatchObject({ start: 42, end: 52 });
    });

    test("ids are never reused", () => {
        const removed = withPartRemoved(three(), 0);
        expect(ids(withPartAdded(removed, 5))).toEqual([2, 3, 4]);
    });
});

describe("withPartRemoved", () => {
    test("keeps the same part selected where it can", () => {
        expect(withPartRemoved(three(), 0)).toMatchObject({ selected: 0 });
        expect(ids(withPartRemoved(three(), 0))).toEqual([2, 3]);
        // The selected part itself: the one that takes its place.
        const removed = withPartRemoved(three(), 1);
        expect(ids(removed)).toEqual([1, 3]);
        expect(removed.selected).toBe(1);
        // The last part, when selected.
        expect(withPartRemoved(withSelection(three(), 2), 2).selected).toBe(1);
    });

    test("the last part left cannot be removed", () => {
        const one = initialParts(60);
        expect(withPartRemoved(one, 0)).toBe(one);
    });
});

describe("withPartMoved", () => {
    test("swaps a part with its neighbour and keeps it selected", () => {
        const earlier = withPartMoved(three(), 1, -1);
        expect(ids(earlier)).toEqual([2, 1, 3]);
        expect(earlier.selected).toBe(0);
        const later = withPartMoved(three(), 1, 1);
        expect(ids(later)).toEqual([1, 3, 2]);
        expect(later.selected).toBe(2);
    });

    test("the selection follows when its neighbour is the one moved", () => {
        const moved = withPartMoved(three(), 0, 1);
        expect(ids(moved)).toEqual([2, 1, 3]);
        expect(moved.selected).toBe(0);
    });

    test("does nothing at the ends", () => {
        const parts = three();
        expect(withPartMoved(parts, 0, -1)).toBe(parts);
        expect(withPartMoved(parts, 2, 1)).toBe(parts);
    });
});

describe("the video's length", () => {
    test("a shorter version pulls every part back inside it", () => {
        const shorter = withVideoDuration(three(), 52);
        expect(shorter.duration).toBe(52);
        expect(shorter.list.map((part) => [part.start, part.end])).toEqual([
            [10, 20],
            [50, 52],
            [30, 31],
        ]);
    });

    test("a version of unknown length keeps the old length", () => {
        expect(withVideoDuration(three(), null)).toEqual(three());
    });

    test("a length found later selects the first 30 seconds of an untouched clip", () => {
        expect(withFoundDuration(initialParts(0), 90).list[0]).toMatchObject({ start: 0, end: 30 });
        expect(withFoundDuration(initialParts(0), 90).duration).toBe(90);
    });

    test("a length found later leaves several parts alone", () => {
        const unknown = { ...three(), duration: 0 };
        expect(withFoundDuration(unknown, 90).list).toEqual(three().list);
    });
});

test("totalLength adds up the parts", () => {
    expect(totalLength(three())).toBe(16);
});

describe("partsProblem", () => {
    test("the limit applies to all parts together", () => {
        expect(partsProblem(three(), 16)).toBe("");
        expect(partsProblem(three(), 15)).toBe("long");
        expect(partsProblem(three(), 0)).toBe("");
    });

    test("every part must be long enough", () => {
        const short = withSelectedEnd(withSelection(three(), 2), 30.3);
        expect(partsProblem(short, 600)).toBe("short");
    });
});
