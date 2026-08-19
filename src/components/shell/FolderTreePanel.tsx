import { useEffect, useState } from "react";

import type { DirEntry } from "../../ipc";
import { listSubdirs, requestDirCounts } from "../../ipc";
import { executeCommand } from "../../registry/commands";
import { useAppStore } from "../../state/store";

const CRUMB_SEGMENTS = 2;

export function FolderTreePanel() {
  const folderPath = useAppStore((s) => (s.scope?.kind === "folder" ? s.scope.path : null));
  const recursive = useAppStore((s) => (s.scope?.kind === "folder" ? s.scope.recursive : false));
  const openFolder = useAppStore((s) => s.openFolder);
  const dirCounts = useAppStore((s) => s.dirCounts);

  const [subdirs, setSubdirs] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    setSubdirs(null);
    if (!folderPath) return;
    let stale = false;
    void listSubdirs(folderPath)
      .then((dirs) => {
        if (stale) return;
        setSubdirs(dirs);
        // Counts stream in as background events so slow (cloud) folders never delay the list itself.
        if (dirs.length > 0) {
          void requestDirCounts(dirs.map((d) => d.path));
        }
      })
      .catch(() => {
        if (!stale) setSubdirs([]);
      });
    return () => {
      stale = true;
    };
  }, [folderPath]);

  if (!folderPath) {
    return (
      <div className="panel-empty">
        <p className="panel-hint">No folder open.</p>
        <button
          className="panel-action"
          onClick={() => executeCommand("folder.open", { store: useAppStore })}
        >
          Open Folder <kbd>⌘O</kbd>
        </button>
      </div>
    );
  }

  const segments = folderPath.split("/").filter(Boolean);
  const shown = segments.slice(-CRUMB_SEGMENTS);
  const hidden = segments.length - shown.length;
  const pathTo = (index: number) => "/" + segments.slice(0, hidden + index + 1).join("/");

  return (
    <div className="folder-tree">
      <div className="crumbs" title={folderPath}>
        {hidden > 0 && (
          <>
            <button className="crumb" onClick={() => void openFolder(pathTo(-1), recursive)}>
              …
            </button>
            <span className="crumb-sep">/</span>
          </>
        )}
        {shown.map((segment, i) =>
          i < shown.length - 1 ? (
            <span key={pathTo(i)}>
              <button className="crumb" onClick={() => void openFolder(pathTo(i), recursive)}>
                {segment}
              </button>
              <span className="crumb-sep">/</span>
            </span>
          ) : (
            <span key={pathTo(i)} className="crumb-current">
              {segment}
            </span>
          ),
        )}
      </div>

      {subdirs === null && <span className="tree-empty">listing…</span>}
      {subdirs?.map((dir) => {
        const count = dirCounts[dir.path];
        return (
          <div key={dir.path} className="tree-row">
            <button
              className="tree-label"
              onClick={() => void openFolder(dir.path, recursive)}
              title={dir.path}
            >
              {dir.name}
            </button>
            {count === undefined ? (
              <span className="tree-count counting" title="counting images…">
                …
              </span>
            ) : (
              count > 0 && <span className="tree-count">{count}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
