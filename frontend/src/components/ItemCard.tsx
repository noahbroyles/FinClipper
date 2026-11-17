import { imageUrl } from "../lib/api";
import { isWide, itemHref, itemSubtitle, mostlyWide } from "../lib/items";
import type { Item } from "../types";

interface CardProps {
    item: Item;
    // Landscape thumbnail instead of a poster.
    wide?: boolean;
}

// A library, folder, show or video as a thumbnail with its name below.
export function ItemCard({ item, wide = isWide(item) }: CardProps) {
    const initial = (item.name || "?").trim().slice(0, 1).toUpperCase();
    return (
        <a class={wide ? "card wide" : "card"} href={itemHref(item)} title={item.name}>
            <div class="thumb">
                {item.image_tag ? (
                    <img src={imageUrl(item, wide ? 270 : 360)} alt="" loading="lazy" />
                ) : (
                    <div class="placeholder">{initial}</div>
                )}
            </div>
            <div class="card-title">{item.name}</div>
            {/* The non-breaking space keeps the line's height when there is no subtitle. */}
            <div class="card-sub">{itemSubtitle(item) || " "}</div>
        </a>
    );
}

interface GridProps {
    items: Item[];
    // Defaults to the wide layout when most items have landscape thumbnails.
    wide?: boolean;
}

export function CardGrid({ items, wide = mostlyWide(items) }: GridProps) {
    return (
        <div class={wide ? "grid landscape" : "grid"}>
            {items.map((item) => (
                <ItemCard key={item.id} item={item} wide={wide} />
            ))}
        </div>
    );
}
