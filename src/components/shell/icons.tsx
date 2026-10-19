import { IconFolder, IconSparkles } from "@tabler/icons-react";

const ICON = { size: 18, stroke: 1.7 } as const;

export function FolderIcon() {
  return <IconFolder {...ICON} />;
}

export function SimilarityIcon() {
  return <IconSparkles {...ICON} />;
}

