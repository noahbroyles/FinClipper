import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { CLIP_NAME_MAX } from "../../constants";
import type { ClipFit, ClipLayout, ClipMode, Source, SubtitleStyle } from "../../types";
import { describeOutput, heightChoices, needsPrecise, selectedSubtitle, type ClipOptions } from "./options";

interface Props {
    // The versions of the video that can be clipped.
    sources: Source[];
    options: ClipOptions;
    subtitleStyles: SubtitleStyle[];
    onSourceChange(index: number): void;
    onAudioChange(index: number): void;
    // Any other option changed.
    onChange(values: Partial<ClipOptions>): void;
    onCreate(): void;
    createDisabled: boolean;
    // What is wrong with the clip's length, if anything; shown as the
    // Create button's tooltip.
    createProblem: string;
}

const FITS: Array<{ value: ClipFit; label: string }> = [
    { value: "crop", label: "Crop the sides" },
    { value: "blur", label: "Whole picture, blurred background" },
    { value: "bars", label: "Whole picture, black bars" },
];

const MODES: Array<{ value: ClipMode; label: string; description: string }> = [
    {
        value: "fast",
        label: "Fast",
        description:
            "Copies the original video without re-encoding. Done in seconds at full quality, but the cut has to begin on a keyframe, so some players show a few extra frames before your start point.",
    },
    {
        value: "precise",
        label: "Precise",
        description:
            "Re-encodes to H.264 MP4. Frame accurate and plays everywhere, but takes longer. HDR is converted to SDR.",
    },
];

const LAYOUTS: Array<{ value: ClipLayout; label: string }> = [
    { value: "horizontal", label: "Horizontal" },
    { value: "vertical", label: "Vertical (phone)" },
];

// Everything about the clip except its start and end: version, audio,
// subtitles, shape, mode, resolution and name, plus the Create button.
export function OptionsPanel(props: Props) {
    const { sources, options, subtitleStyles, onChange } = props;
    const source = sources[options.sourceIndex]!;
    const subtitle = selectedSubtitle(source, options);
    const vertical = options.layout === "vertical";
    const forcedPrecise = needsPrecise(options);
    const layoutGroup = useId();
    const modeGroup = useId();

    return (
        <section class="panel">
            <h3>Options</h3>
            {sources.length > 1 ? (
                <Field label="Version">
                    <select
                        value={String(options.sourceIndex)}
                        onChange={(event) => props.onSourceChange(Number(event.currentTarget.value))}
                    >
                        {sources.map((version, index) => (
                            <option key={version.id} value={String(index)}>
                                {version.name}
                            </option>
                        ))}
                    </select>
                </Field>
            ) : null}
            <Field label="Audio track">
                <select
                    value={String(options.audioIndex)}
                    onChange={(event) => props.onAudioChange(Number(event.currentTarget.value))}
                >
                    {source.audio.map((track) => (
                        <option key={track.index} value={String(track.index)}>
                            {track.title}
                        </option>
                    ))}
                    <option value="-1">No audio</option>
                </select>
            </Field>
            <Field label="Burn in subtitles">
                <select
                    value={options.subtitleIndex === null ? "" : String(options.subtitleIndex)}
                    disabled={!source.subtitles.length}
                    onChange={(event) => {
                        const value = event.currentTarget.value;
                        onChange({ subtitleIndex: value === "" ? null : Number(value) });
                    }}
                >
                    <option value="">{source.subtitles.length ? "None" : "None (this video has no subtitles)"}</option>
                    {source.subtitles.map((track) => (
                        <option key={track.index} value={String(track.index)}>
                            {track.kind === "bitmap" ? `${track.title} (picture)` : track.title}
                        </option>
                    ))}
                </select>
            </Field>
            {subtitle?.kind === "text" ? (
                <Field label="Subtitle style">
                    <select
                        value={options.subtitleStyle}
                        onChange={(event) => onChange({ subtitleStyle: event.currentTarget.value })}
                    >
                        {subtitleStyles.map((style) => (
                            <option key={style.id} value={style.id}>
                                {style.label}
                            </option>
                        ))}
                    </select>
                </Field>
            ) : null}
            {subtitle ? (
                <p class="output-note">
                    {subtitle.kind === "bitmap"
                        ? "Picture subtitles keep their original look. The preview player does not show subtitles."
                        : "The preview player does not show subtitles."}
                </p>
            ) : null}

            <div class="field">
                <span>Shape</span>
                <div class="segmented">
                    {LAYOUTS.map((layout) => (
                        <label key={layout.value}>
                            <input
                                type="radio"
                                name={layoutGroup}
                                value={layout.value}
                                checked={options.layout === layout.value}
                                onChange={() => onChange({ layout: layout.value })}
                            />
                            <span>{layout.label}</span>
                        </label>
                    ))}
                </div>
            </div>
            {vertical ? (
                <Field label="Framing">
                    <select value={options.fit} onChange={(event) => onChange({ fit: event.currentTarget.value as ClipFit })}>
                        {FITS.map((fit) => (
                            <option key={fit.value} value={fit.value}>
                                {fit.label}
                            </option>
                        ))}
                    </select>
                </Field>
            ) : null}
            {/* Both sliders move the outline drawn on the preview (CropGuide). */}
            {vertical && options.fit === "crop" ? (
                <Field label="Crop width (wider adds black bars above and below)">
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={String(Math.round(options.cropWidth * 100))}
                        onInput={(event) => onChange({ cropWidth: Number(event.currentTarget.value) / 100 })}
                    />
                </Field>
            ) : null}
            {vertical && options.fit === "crop" ? (
                <Field label="Crop position (shown on the preview)">
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={String(Math.round(options.cropX * 100))}
                        onInput={(event) => onChange({ cropX: Number(event.currentTarget.value) / 100 })}
                    />
                </Field>
            ) : null}

            <div class="field">
                <span>Mode</span>
                <div class="modes">
                    {MODES.map((mode) => (
                        <label key={mode.value} class="mode">
                            <input
                                type="radio"
                                name={modeGroup}
                                value={mode.value}
                                checked={options.mode === mode.value}
                                disabled={mode.value === "fast" && forcedPrecise}
                                onChange={() => onChange({ mode: mode.value })}
                            />
                            <div>
                                <strong>{mode.label}</strong>
                                <small>{mode.description}</small>
                            </div>
                        </label>
                    ))}
                </div>
            </div>
            {forcedPrecise ? (
                <p class="output-note">
                    Fast mode copies the video as it is, so it cannot add subtitles or change the shape. Precise mode is
                    used.
                </p>
            ) : null}
            {options.mode === "precise" ? (
                <Field label="Resolution">
                    <select
                        value={String(options.maxHeight)}
                        onChange={(event) => onChange({ maxHeight: Number(event.currentTarget.value) })}
                    >
                        {heightChoices(source, options.layout).map((choice) => (
                            <option key={choice.value} value={String(choice.value)}>
                                {choice.label}
                            </option>
                        ))}
                    </select>
                </Field>
            ) : null}

            <Field label="Clip name">
                <input
                    type="text"
                    maxLength={CLIP_NAME_MAX}
                    placeholder="Optional, defaults to the video title"
                    spellcheck={false}
                    autocomplete="off"
                    value={options.name}
                    onInput={(event) => onChange({ name: event.currentTarget.value })}
                />
            </Field>
            <p class="output-note">{describeOutput(source, options)}</p>
            <button
                class="btn primary create"
                type="button"
                disabled={props.createDisabled}
                title={props.createProblem}
                onClick={props.onCreate}
            >
                Create clip
            </button>
        </section>
    );
}

// A labelled form control.
function Field({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <label class="field">
            <span>{label}</span>
            {children}
        </label>
    );
}
