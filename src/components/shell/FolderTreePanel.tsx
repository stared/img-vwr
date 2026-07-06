import { useCallback, useEffect, useState } from "react";

import type { DirEntry } from "../../ipc";
import { listSubdirs } from "../../ipc";
import { useAppStore } from "../../state/store";

/** Lazy one-level-at-a-time folder tree rooted at the opened folder. */
export function FolderTreePanel() {
  const folderPath = useAppStore((s) => s.folderPath);
  const openFolder = useAppStore((s) => s.openFolder);

  if (!folderPath) {
    return <p className="panel-hint">Open a folder to browse.</p>;
  }

  const parent = parentDir(folderPath);
  return (
    <div className="folder-tree">
      {parent && (
        <button className="tree-up" onClick={() => void openFolder(parent)} title={parent}>
          ↰ ..
        </button>
      )}
      <TreeNode path={folderPath} name={baseName(folderPath)} depth={0} initiallyOpen />
    </div>
  );
}

interface TreeNodeProps {
  path: string;
  name: string;
  depth: number;
  initiallyOpen?: boolean;
}

function TreeNode({ path, name, depth, initiallyOpen = false }: TreeNodeProps) {
  const folderPath = useAppStore((s) => s.folderPath);
  const openFolder = useAppStore((s) => s.openFolder);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      setChildren(await listSubdirs(path));
    } catch {
      setChildren([]);
    }
  }, [path]);

  useEffect(() => {
    if (expanded && children === null) void load();
  }, [expanded, children, load]);

  return (
    <div className="tree-node" style={{ paddingLeft: depth * 12 }}>
      <div className={`tree-row ${folderPath === path ? "current" : ""}`}>
        <button className="tree-twisty" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▾" : "▸"}
        </button>
        <button className="tree-label" onClick={() => void openFolder(path)} title={path}>
          {name}
        </button>
      </div>
      {expanded &&
        children?.map((child) => (
          <TreeNode key={child.path} path={child.path} name={child.name} depth={depth + 1} />
        ))}
      {expanded && children?.length === 0 && (
        <span className="tree-empty" style={{ paddingLeft: 20 }}>
          no subfolders
        </span>
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function parentDir(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return parts.length === 1 ? "/" : null;
  return "/" + parts.slice(0, -1).join("/");
}
