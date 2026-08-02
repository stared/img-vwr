import { ImageCanvas } from "./ImageCanvas";

/**
 * Full-screen viewing: the image and nothing else. The darkroom is the same
 * canvas with a filmstrip and the develop panel around it.
 */
export function ImageViewer() {
  return <ImageCanvas />;
}
