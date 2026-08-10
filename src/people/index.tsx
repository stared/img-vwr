import { useEffect, useRef } from "react";

import { facesIndex, facesPeople, fileUrl, type PersonCluster } from "../ipc";
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

/**
 * The counts, tagged by frame situation: [1] alone in frame, [2+] sharing
 * it with comparable others, [bg] in the background. Zero counts are
 * omitted — a tag names its number, so nothing is positional.
 */
function countTags(person: PersonCluster): { tag: string; n: number; dim: boolean }[] {
  const tags = [];
  if (person.solo.length > 0) tags.push({ tag: "[1]", n: person.solo.length, dim: false });
  if (person.few.length > 0) tags.push({ tag: "[2+]", n: person.few.length, dim: false });
  if (person.background.length > 0)
    tags.push({ tag: "[bg]", n: person.background.length, dim: true });
  return tags;
}

const TAG_LEGEND =
  "[1] alone in frame · [2+] sharing it with others · [bg] in the background";

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
  try {
    const clusters = await facesPeople(paths, PERSON_SIM, PERSON_MERGE, PERSON_PROPAGATE);
    useAppStore.getState().peopleLoaded(clusters.filter((c) => c.photos.length >= MIN_FACES));
  } catch (error) {
    console.warn("clustering people failed", error);
  }
}

export function PeoplePanel() {
  const scope = useAppStore((s) => s.scope);
  const entryCount = useAppStore((s) => s.entries.length);
  const people = useAppStore((s) => s.people);
  const progress = useAppStore((s) => s.facesProgress);
  const modelReady = useAppStore((s) => s.embedStatus?.phase === "ready");
  const epoch = useAppStore((s) => s.epoch);
  const query = useAppStore((s) => s.query);
  const toggleSelectFilter = useAppStore((s) => s.toggleSelectFilter);

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

  return (
    <div className="people-panel">
      {!modelReady && (
        <p className="panel-hint">
          Turned-away shots join their person only with a Similarity model loaded.
        </p>
      )}
      <button
        className="people-scan"
        disabled={indexing}
        onClick={() => {
          void facesIndex(localJpegPaths(), epoch);
        }}
        title="detect faces in every photo, then group them into people — cached, so a re-run only reads new photos"
      >
        {indexing
          ? `looking: ${progress.done} / ${progress.total}`
          : people === null
            ? "find people"
            : `found ${people.length} people — again`}
      </button>
      {people !== null && people.length === 0 && (
        <p className="panel-hint">No faces found.</p>
      )}
      {people !== null && people.length > 0 && (
        <div className="people-grid">
          {people.map((person) => (
            <button
              key={person.id}
              className={`person-chip ${active.has(person.id) ? "active" : ""}`}
              onClick={() => toggleSelectFilter("person", person.id)}
              title={`${TAG_LEGEND}${person.implied.length > 0 ? ` · +${person.implied.length} near-identical without the face` : ""}`}
            >
              <img src={fileUrl(person.cover)} alt={`person ${person.id}`} draggable={false} />
              <span>person {person.id}</span>
              <span className="person-counts">
                {countTags(person).map(({ tag, n, dim }) => (
                  <span key={tag} className={dim ? "person-bg" : ""}>
                    {tag}
                    {n}
                  </span>
                ))}
              </span>
            </button>
          ))}
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
    return <p className="menu-hint-row">no people found yet — see the People panel</p>;
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
          person {person.id} ·{" "}
          {countTags(person)
            .map(({ tag, n }) => `${tag}${n}`)
            .join(" ")}
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
