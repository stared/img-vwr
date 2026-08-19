import type { CSSProperties } from "react";

import type { Crop } from "../../ipc";

/** `frame` is the photo's pixel aspect (width over height), which the normalised crop cannot know. */
export function croppedBoxRatio(crop: Crop, frame: number): number {
  return (frame * crop.width) / Math.max(crop.height, 1e-6);
}

export function CroppedThumb({
  src,
  alt,
  crop,
  frame,
  className,
}: {
  src: string;
  alt: string;
  crop: Crop;
  frame: number;
  className?: string;
}) {
  const box = {
    "--crop-ar": String(croppedBoxRatio(crop, frame)),
  } as CSSProperties;
  const img: CSSProperties = {
    width: `${100 / crop.width}%`,
    height: `${100 / crop.height}%`,
    left: `${(-crop.x / crop.width) * 100}%`,
    top: `${(-crop.y / crop.height) * 100}%`,
  };
  // The renderer (crop.rs) samples the crop rectangle rotated clockwise by `angle`, so display turns by `-angle`.
  if (crop.angle !== 0) {
    img.transform = `rotate(${-crop.angle}deg)`;
    img.transformOrigin = `${(crop.x + crop.width / 2) * 100}% ${
      (crop.y + crop.height / 2) * 100
    }%`;
  }
  return (
    <span className={className ? `thumb-cropped ${className}` : "thumb-cropped"} style={box}>
      <img src={src} alt={alt} loading="lazy" draggable={false} style={img} />
    </span>
  );
}

export function CropBadge() {
  return (
    <span className="thumb-crop" title="cropped — the miniature shows the crop">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.13 1L6 16a2 2 0 0 0 2 2h15" />
        <path d="M1 6.13L16 6a2 2 0 0 1 2 2v15" />
      </svg>
    </span>
  );
}
