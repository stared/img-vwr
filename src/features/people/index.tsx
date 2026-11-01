import { events } from "../../ipc";
import { registerFilterField } from "../../registry/filters";
import { always, registerPanel } from "../../registry/panels";
import { isAnyPicked, isPicked } from "../../state/query";
import { useAppStore } from "../../state/store";
import "./people.css";
import { CountsRow, PeoplePanel, personLabel } from "./PeoplePanel";
import { followScope, PEOPLE, usePeopleStore } from "./store";

const ANYONE = "anyone";

function PersonMenuItems() {
  const people = usePeopleStore((s) => s.people);
  const query = useAppStore((s) => s.query);
  const toggleSelectFilter = useAppStore((s) => s.toggleSelectFilter);
  const toggleSelectAny = useAppStore((s) => s.toggleSelectAny);
  if (people === null || people.length === 0) {
    return <span className="menu-empty">no people found yet; see the People panel</span>;
  }
  return (
    <>
      <button onClick={() => toggleSelectAny("person")}>
        {ANYONE}
        <span className="menu-check">{isAnyPicked(query, "person") ? "✓" : ""}</span>
      </button>
      {people.map((person) => (
        <button key={person.id} onClick={() => toggleSelectFilter("person", person.id)}>
          {personLabel(person)}
          <CountsRow person={person} />
          <span className="menu-check">{isPicked(query, "person", person.id) ? "✓" : ""}</span>
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
    reads: [PEOPLE],
    Menu: PersonMenuItems,
    values: (_entry, data) => data.get(PEOPLE),
    anyLabel: ANYONE,
  });

  registerPanel({
    id: "people",
    title: "People",
    component: PeoplePanel,
    icon: "☺",
    side: "left",
    order: 40,
    fill: false,
    when: always,
  });

  // Progress belongs to the folder it was started for; a new scope starts the feature over.
  void events.facesProgress.listen(({ payload }) => {
    if (payload.epoch === useAppStore.getState().epoch) {
      usePeopleStore.getState().setProgress({ done: payload.done, total: payload.total });
    }
  });
  followScope();
}
