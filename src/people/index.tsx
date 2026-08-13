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

/**
 * People: who is in the photographs, as a view over the collection.
 *
 * The Rust side detects faces (cached per photo), crops them, and clusters
 * the crops' embedding vectors into people. Here that becomes a panel of
 * face chips and a `person` filter field — clicking a face is the complete
 * clause "photos with this person", chip and all, exactly like clicking a
 * star row or a tag.
 */

/**
 * A face joins a person when its identity vector matches this well.
 *
 * The space is a real face recognizer (ArcFace-family), not the Similarity
 * panel's general model — same-person cosine similarity separates cleanly
 * from different-person there, so the threshold sits where the two
 * distributions part rather than pinned defensively near 1.
 */
const PERSON_SIM = 0.45;

/**
 * Cluster fragments whose members agree this well pairwise, on average,
 * are one person photographed in two conditions (day and stage light).
 * Average linkage, not centroids — see the Rust side for why centroids
 * of different people converge as clusters grow.
 */
const PERSON_MERGE = 0.38;

/**
 * A faceless photo joins a person's photos when it is at least this similar
 * to one where their face IS visible — the same "near-identical, whatever
 * the clock says" bar the scene merging uses: they turned away between two
 * shots of the same moment.
 */
const PERSON_PROPAGATE = 0.92;

/** Clusters below this many faces are noise, not people worth a chip. */
const MIN_FACES = 3;

/* One head-and-shoulders silhouette; the vocabulary for "people in the
 * frame". Alone = one filled figure, sharing = two overlapping, background
 * = a hollow outline — the emptiness is the point. */

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

/**
 * The counts by frame situation, each wearing its silhouette. Zero counts
 * are omitted — an icon names its number, so nothing is positional.
 */
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

/** The chip's text: the given name, or "person N" until there is one. */
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
  // The camera's JPGs carry the same faces as the raws beside them, and
  // they decode fast — the negatives add nothing but decoding failures.
  return s.entries.filter((e) => !isRawEntry(e)).map((e) => e.path);
}

async function refreshPeople(): Promise<void> {
  const paths = localJpegPaths();
  if (paths.length === 0) return;
  const epoch = useAppStore.getState().epoch;
  try {
    const clusters = await facesPeople(paths, PERSON_SIM, PERSON_MERGE, PERSON_PROPAGATE);
    // The folder changed while clustering ran; these are its people, not ours.
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
  /** The cluster whose name is being edited in place, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [knownNames, setKnownNames] = useState<string[]>([]);

  // People are a view over the folder, not a job to order: opening the
  // panel looks for faces by itself. A folder seen before is a cache read;
  // photos appearing on disk later re-fire this through the entry count.
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

  // When a detection pass finishes, cluster — and once only per finish.
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
        // The person's id is about to change with their name — keep an
        // active filter pointing at them, or drop it when the name (and
        // with it the stable id) is gone.
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
          looking: {progress.done} / {progress.total}
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
    return <p className="menu-hint-row">no people found yet; see the People panel</p>;
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
