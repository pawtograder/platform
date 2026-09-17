/**
 * The coverage sweep resolves axe's one undecidable `aria-valid-attr-value`
 * case itself (see scan.ts). These tests pin the decision so it cannot quietly
 * widen into "ignore aria-valid-attr-value on popup triggers", which would hide
 * a genuinely broken reference.
 */
import { popupControlIdrefs, withoutResolvedPopupControls } from "../e2e/a11y/scan";

/** A node as axe reports it for the aria-haspopup pre-check bail-out. */
function undecidedNode(target: string, ariaControls: string) {
  return {
    target: [target],
    all: [
      {
        id: "aria-valid-attr-value",
        data: { messageKey: "controlsWithinPopup", needsReview: `aria-controls="${ariaControls}"` }
      }
    ]
  };
}

/** A node axe flagged because the id really is absent. */
function missingIdNode(target: string, attr: string) {
  return {
    target: [target],
    all: [{ id: "aria-valid-attr-value", data: { messageKey: "noId", needsReview: attr } }]
  };
}

describe("popupControlIdrefs", () => {
  it("reads the ids out of an undecided aria-controls", () => {
    expect(popupControlIdrefs(undecidedNode("#trigger", "popover-content"))).toEqual(["popover-content"]);
  });

  it("splits a multi-id aria-controls", () => {
    expect(popupControlIdrefs(undecidedNode("#trigger", "one two"))).toEqual(["one", "two"]);
  });

  it("returns null for a node flagged for any other reason", () => {
    expect(popupControlIdrefs(missingIdNode("#group", 'aria-labelledby="gone"'))).toBeNull();
    expect(popupControlIdrefs({ target: ["#x"], all: [] })).toBeNull();
  });
});

describe("withoutResolvedPopupControls", () => {
  const exists = (id: string) => id === "present";

  it("drops a trigger whose popup id resolves", () => {
    expect(withoutResolvedPopupControls([undecidedNode("#trigger", "present")], exists)).toEqual([]);
  });

  it("keeps a trigger whose popup id does not resolve", () => {
    const nodes = [undecidedNode("#trigger", "absent")];
    expect(withoutResolvedPopupControls(nodes, exists)).toEqual(nodes);
  });

  it("keeps a trigger when only some of its ids resolve", () => {
    const nodes = [undecidedNode("#trigger", "present absent")];
    expect(withoutResolvedPopupControls(nodes, exists)).toEqual(nodes);
  });

  it("keeps an empty aria-controls", () => {
    const nodes = [undecidedNode("#trigger", "")];
    expect(withoutResolvedPopupControls(nodes, exists)).toEqual(nodes);
  });

  it("leaves nodes flagged for other reasons alone", () => {
    const dangling = missingIdNode("#group", 'aria-labelledby="gone"');
    expect(withoutResolvedPopupControls([undecidedNode("#trigger", "present"), dangling], exists)).toEqual([dangling]);
  });
});
