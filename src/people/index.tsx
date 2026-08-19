import { useEffect, useRef, useState } from "react";

import {
  facesIndex,
  facesNames,
  facesPeople,
  facesRename,
  fileUrl,
  type PersonCluster,
} from "../ipc";
import { registerFilterField } from "../registry/filters";
import { isRawEntry } from "../state/stacks";
import { useAppStore } from "../state/store";

/** Same-person cosine threshold in the ArcFace identity space, not the Similarity panel's model. */
const PERSON_SIM = 0.45;

/** Average-linkage merge threshold; see the Rust side for why centroids of different people converge. */
const PERSON_MERGE = 0.38;

/** Faceless-photo propagation bar — the same near-identical threshold scene merging uses. */
const PERSON_PROPAGATE = 0.92;

/** Clusters below this many faces are noise, not people worth a chip. */
const MIN_FACES = 3;

function PersonShape({ x, hollow, faded }: { x: number; hollow: boolean; faded: boolean }) {
  return (
    <g
      transform={`translate(${x} 0)`}
      opacity={faded ? 0.45 : 1}
      fill={hollow ? "none" : "currentColor"}
      stroke={hollow ? "currentColor" : "none"}
      strokeWidth={hollow ? 1.6 : 0}
    >
      <circle cx="8" cy="4.6" r="3.1" />
      <path d="M2.2 14.6a5.8 5.8 0 0 1 11.6 0Z" />
    </g>
  );
}

function SoloIcon() {
  return (
    <svg viewBox="0 0 16 16" className="role-icon" aria-label="alone in frame">
      <PersonShape x={0} hollow={false} faded={false} />
    </svg>
  );
}

function FewIcon() {
  return (
    <svg viewBox="0 0 22 16" className="role-icon role-icon-wide" aria-label="with others">
      <PersonShape x={6} hollow={false} faded={true} />
      <PersonShape x={0} hollow={false} faded={false} />
    </svg>
  );
}

function BgIcon() {
  return (
    <svg viewBox="0 0 16 16" className="role-icon" aria-label="in the background">
      <PersonShape x={0} hollow={true} faded={false} />
    </svg>
  );
}

function countTags(
  person: PersonCluster,
): { key: string; Icon: () => React.JSX.Element; n: number; dim: boolean }[] {
  const tags = [];
  if (person.solo.length > 0)
    tags.push({ key: "solo", Icon: SoloIcon, n: person.solo.length, dim: false });
  if (person.few.length > 0)
    tags.push({ key: "few", Icon: FewIcon, n: person.few.length, dim: false });
  if (person.background.length > 0)
    tags.push({ key: "bg", Icon: BgIcon, n: person.background.length, dim: true });
  return tags;
}

const TAG_LEGEND =
  "counts: alone in frame · sharing it with others · in the background (hollow)";

function personLabel(person: PersonCluster): string {
  return person.name ?? `person ${person.id}`;
}

function CountsRow({ person }: { person: PersonCluster }) {
  return (
    <span className="person-counts">
      {countTags(person).map(({ key, Icon, n, dim }) => (
        <span key={key} className={dim ? "person-bg" : ""}>
          <Icon />
          {n}
        </span>
      ))}
    </span>
  );
}

function localJpegPaths(): string[] {
  const s = useAppStore.getState();
  if (s.scope?.kind !== "folder") return [];
  // Raws are skipped: sibling JPGs carry the same faces, and the negatives often fail to decode.
  return s.entries.filter((e) => !isRawEntry(e)).map((e) => e.path);
}

async function refreshPeople(): Promise<void> {
  const paths = localJpegPaths();
  if (paths.length === 0) return;
  const epoch = useAppStore.getState().epoch;
  try {
    const clusters = await facesPeople(paths, PERSON_SIM, PERSON_MERGE, PERSON_PROPAGATE);
    if (useAppStore.getState().epoch !== epoch) return;
    useAppStore.getState().peopleLoaded(clusters.filter((c) => c.photos.length >= MIN_FACES));
  } catch (error) {
    console.warn("clustering people failed", error);
  }
}

export function PeoplePanel() {
  const scope = useAppStore((s) => s.scope);
  const entryCount = useAppStore((s) => s.entries.length);
  const status = useAppStore((s) => s.status);
  const people = useAppStore((s) => s.people);
  const progress = useAppStore((s) => s.facesProgress);
  const epoch = useAppStore((s) => s.epoch);
  const query = useAppStore((s) => s.query);
  const toggleSelectFilter = useAppStore((s) => s.toggleSelectFilter);
  const setSelectFilter = useAppStore((s) => s.setSelectFilter);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [knownNames, setKnownNames] = useState<string[]>([]);

  // Photos appearing on disk later re-fire this through the entryCount dependency.
  const indexedFor = useRef<string | null>(null);
  useEffect(() => {
    if (scope?.kind !== "folder" || status !== "loaded") return;
    const paths = localJpegPaths();
    if (paths.length === 0) return;
    const key = `${epoch}:${paths.length}`;
    if (indexedFor.current === key) return;
    indexedFor.current = key;
    void facesIndex(paths, epoch);
  }, [scope, status, epoch, entryCount]);

  const clusteredFor = useRef<string | null>(null);
  useEffect(() => {
    if (progress === null || progress.done < progress.total) return;
    const key = `${epoch}:${progress.total}`;
    if (clusteredFor.current === key) return;
    clusteredFor.current = key;
    void refreshPeople();
  }, [progress, epoch]);

  if (scope?.kind !== "folder") {
    return <p className="panel-hint">People live in local folders.</p>;
  }
  if (entryCount === 0) {
    return <p className="panel-hint">No images here.</p>;
  }

  const indexing = progress !== null && progress.done < progress.total;
  const active = new Set(
    query.filters.flatMap((f) => (f.kind === "select" && f.field === "person" ? [f.value] : [])),
  );

  async function commitName(person: PersonCluster): Promise<void> {
    const name = draft.trim();
    setEditing(null);
    if (name === (person.name ?? "")) return;
    try {
      await facesRename(person.id, name, PERSON_MERGE);
      if (active.has(person.id)) {
        // Renaming changes the cluster id; re-point an active filter, or drop it on un-name.
        if (name !== "") setSelectFilter("person", name);
        else toggleSelectFilter("person", person.id);
      }
      await refreshPeople();
    } catch (error) {
      console.warn("naming person failed", error);
    }
  }

  function startEditing(person: PersonCluster): void {
    setDraft(person.name ?? "");
    setEditing(person.id);
    facesNames().then(setKnownNames, () => setKnownNames([]));
  }

  return (
    <div className="people-panel">
      {indexing && (
        <p className="panel-hint">
          looking for faces… {progress.done} of {progress.total} photographs
        </p>
      )}
      {!indexing && people !== null && people.length === 0 && (
        <p className="panel-hint">No faces found.</p>
      )}
      {people !== null && people.length > 0 && (
        <div className="people-grid">
          {people.map((person) =>
            editing === person.id ? (
              <div key={person.id} className="person-chip">
                <img src={fileUrl(person.cover)} alt={personLabel(person)} draggable={false} />
                <input
                  className="person-name-input"
                  value={draft}
                  autoFocus
                  list="person-name-options"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitName(person);
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => setEditing(null)}
                />
                <CountsRow person={person} />
              </div>
            ) : (
              <button
                key={person.id}
                className={`person-chip ${active.has(person.id) ? "active" : ""}`}
                onClick={() => toggleSelectFilter("person", person.id)}
                title={`${TAG_LEGEND}${person.implied.length > 0 ? ` · +${person.implied.length} near-identical without the face` : ""}`}
              >
                <img src={fileUrl(person.cover)} alt={personLabel(person)} draggable={false} />
                <span
                  className="person-name"
                  title="click to name — the same name given twice merges the two"
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditing(person);
                  }}
                >
                  {personLabel(person)}
                </span>
                <CountsRow person={person} />
              </button>
            ),
          )}
          <datalist id="person-name-options">
            {knownNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      )}
    </div>
  );
}

function PersonMenuItems({ close }: { close: () => void }) {
  const people = useAppStore((s) => s.people);
  const query = useAppStore((s) => s.query);
  const setSelectFilter = useAppStore((s) => s.setSelectFilter);
  const active = query.filters.find((f) => f.kind === "select" && f.field === "person");
  if (people === null || people.length === 0) {
    return <span className="menu-empty">no people found yet; see the People panel</span>;
  }
  return (
    <>
      {people.map((person) => (
        <button
          key={person.id}
          onClick={() => {
            setSelectFilter("person", person.id);
            close();
          }}
        >
          {personLabel(person)}
          <CountsRow person={person} />
          <span className="menu-check">
            {active?.kind === "select" && active.value === person.id ? "✓" : ""}
          </span>
        </button>
      ))}
    </>
  );
}

export function registerPeople(): void {
  registerFilterField({
    kind: "flags",
    id: "person",
    label: "person",
    appliesTo: (scope) => scope?.kind === "folder",
    reads: "people",
    Menu: PersonMenuItems,
    values: (_entry, { people }) => people,
  });
}
