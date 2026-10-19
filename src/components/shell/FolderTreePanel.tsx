import { IconPin, IconPinned } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import type { DirEntry } from "../../ipc";
import { api } from "../../ipc";
import { executeCommand } from "../../registry/commands";
import { chordsForCommand, formatChord } from "../../registry/keybindings";
import { useAppStore } from "../../state/store";

const CRUMB_SEGMENTS = 2;
function OpenFolderRow() {
  return (
    <button
      className="tree-label open-folder"
      onClick={() => executeCommand("folder.open", { store: useAppStore })}
    >
      Open Folder…
      <kbd>{chordsForCommand("folder.open").map(formatChord)[0]}</kbd>
    </button>
  );
}

function PinButton({ path }: { path: string }) {
  const pinned = useAppStore((s) => s.pinnedFolders.includes(path));
  const toggleFolderPin = useAppStore((s) => s.toggleFolderPin);
  return (
    <button
      className="folder-pin"
      aria-pressed={pinned}
      title={pinned ? "Unpin folder" : "Pin folder · keep it in Pinned"}
      onClick={() => toggleFolderPin(path)}
    >
      {pinned ? <IconPinned size={13} /> : <IconPin size={13} />}
    </button>
  );
}

function FolderRow({ path }: { path: string }) {
  const openFolder = useAppStore((s) => s.openFolder);
  return (
    <div className="tree-row folder-row">
      <button className="tree-label" onClick={() => void openFolder(path, false)} title={path}>
        {path.split("/").filter(Boolean).pop()}
      </button>
      <PinButton path={path} />
    </div>
  );
}

function RecentFolders() {
  const pinned = useAppStore((s) => s.pinnedFolders);
  const recent = useAppStore((s) => s.recentFolders).filter((p) => !pinned.includes(p));
  return (
    <section className="folder-recent">
      {pinned.length > 0 && <h4>Pinned</h4>}
      {pinned.map((path) => (
        <FolderRow key={path} path={path} />
      ))}
      {recent.length > 0 && <h4>Recent</h4>}
      {recent.map((path) => (
        <FolderRow key={path} path={path} />
      ))}
      <OpenFolderRow />
    </section>
  );
}

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
    void api.listSubdirs(folderPath)
      .then((dirs) => {
        if (stale) return;
        setSubdirs(dirs);
        // Counts stream in as background events so slow (cloud) folders never delay the list itself.
        if (dirs.length > 0) {
          void api.requestDirCounts(dirs.map((d) => d.path));
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
      <div className="folder-tree">
        <RecentFolders />
      </div>
    );
  }

  const segments = folderPath.split("/").filter(Boolean);
  const shown = segments.slice(-CRUMB_SEGMENTS);
  const hidden = segments.length - shown.length;
  const pathTo = (index: number) => "/" + segments.slice(0, hidden + index + 1).join("/");

  return (
    <div className="folder-tree">
      <div className="crumbs-row">
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
        <PinButton path={folderPath} />
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
      <RecentFolders />
    </div>
  );
}
