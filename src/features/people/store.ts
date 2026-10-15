import { create } from "zustand";

import { facesPeople, type PersonCluster } from "../../ipc";
import { storeChannel } from "../../registry/channels";
import { isRawEntry } from "../../state/stacks";
import { useAppStore } from "../../state/store";

/** Same-person cosine threshold in the ArcFace identity space, not the Similarity panel's model. */
const PERSON_SIM = 0.45;

/** Average-linkage merge threshold; see the Rust side for why centroids of different people converge. */
export const PERSON_MERGE = 0.38;

/** Faceless-photo propagation bar — the same near-identical threshold scene merging uses. */
const PERSON_PROPAGATE = 0.92;

/** Clusters below this many faces are noise, not people worth a chip. */
const MIN_FACES = 3;

interface PeopleState {
  /** Face clusters, biggest first; null until a pass has run for this folder. */
  people: PersonCluster[] | null;
  /** photo path → person-cluster ids (detected or implied); rebuilt whenever `people` lands. */
  byPath: Record<string, string[]>;
  /** Face-detection progress; null when idle. */
  progress: { done: number; total: number } | null;
  loaded: (people: PersonCluster[]) => void;
  setProgress: (progress: { done: number; total: number } | null) => void;
  reset: () => void;
}

export const usePeopleStore = create<PeopleState>()((set) => ({
  people: null,
  byPath: {},
  progress: null,
  loaded: (people) => {
    const byPath: Record<string, string[]> = {};
    for (const cluster of people) {
      for (const path of [...cluster.photos, ...cluster.implied]) {
        (byPath[path] ??= []).push(cluster.id);
      }
    }
    set({ people, byPath });
  },
  setProgress: (progress) => set({ progress }),
  reset: () => set({ people: null, byPath: {}, progress: null }),
}));

/** A finished pass left standing would auto-cluster the next folder and announce "No faces found.". */
export function followScope(): void {
  let epoch = useAppStore.getState().epoch;
  useAppStore.subscribe((s) => {
    if (s.epoch === epoch) return;
    epoch = s.epoch;
    usePeopleStore.getState().reset();
  });
}

/** path → ids of the people in it; empty, never unknown. */
export const PEOPLE = storeChannel<PeopleState, string[]>(usePeopleStore, (s) => s.byPath, []);

export function localJpegPaths(): string[] {
  const s = useAppStore.getState();
  if (s.scope?.kind !== "folder") return [];
  // Raws are skipped: sibling JPGs carry the same faces, and the negatives often fail to decode.
  return s.entries.filter((e) => !isRawEntry(e)).map((e) => e.path);
}

let refreshing = false;
let rerun = false;

/** Clustering reads only photos already scanned, so it is safe mid-scan; a call during a run queues one more. */
export async function refreshPeople(): Promise<void> {
  if (refreshing) {
    rerun = true;
    return;
  }
  refreshing = true;
  try {
    do {
      rerun = false;
      await clusterPeople();
    } while (rerun);
  } finally {
    refreshing = false;
  }
}

async function clusterPeople(): Promise<void> {
  const paths = localJpegPaths();
  if (paths.length === 0) return;
  const epoch = useAppStore.getState().epoch;
  try {
    const clusters = await facesPeople(paths, PERSON_SIM, PERSON_MERGE, PERSON_PROPAGATE);
    if (useAppStore.getState().epoch !== epoch) return;
    usePeopleStore.getState().loaded(clusters.filter((c) => c.photos.length >= MIN_FACES));
  } catch (error) {
    console.warn("clustering people failed", error);
  }
}
