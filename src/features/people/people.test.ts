import { describe, expect, it } from "vitest";

import { useAppStore } from "../../state/store";
import { followScope, usePeopleStore } from "./store";

describe("people store", () => {
  it("forgets the previous folder's people and their finished detection", () => {
    followScope();
    usePeopleStore.getState().loaded([]);
    usePeopleStore.getState().setProgress({ done: 3, total: 3 });
    useAppStore.setState({ epoch: useAppStore.getState().epoch + 1 });
    const { people, byPath, progress } = usePeopleStore.getState();
    expect(people).toBeNull();
    expect(byPath).toEqual({});
    expect(progress).toBeNull();
  });
});
