import { events } from "../../ipc";
import { registerFilterField } from "../../registry/filters";
import { always, registerPanel } from "../../registry/panels";
import { useAppStore } from "../../state/store";
import "./people.css";
import { CountsRow, PeoplePanel, personLabel } from "./PeoplePanel";
import { followScope, PEOPLE, usePeopleStore } from "./store";

function PersonMenuItems({ close }: { close: () => void }) {
  const people = usePeopleStore((s) => s.people);
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
    reads: [PEOPLE],
    Menu: PersonMenuItems,
    values: (_entry, data) => data.get(PEOPLE),
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
