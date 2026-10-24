/**
 * Unit tests for the a11y-judge evidence canonical hash + schema.
 *
 * LOCATION NOTE: the Wave-1A prompt asks for this test at
 * tools/a11y-judge/schema/evidence.test.ts, but this repo's jest config
 * (jest.config.js) only discovers tests under tests/unit (testMatch scans
 * that directory). Per the prompt's fallback instruction, the test lives here
 * and imports from tools/.
 */
import {
  canonicalizeForHash,
  computeContentHash,
  EvidenceBundleSchema,
  type EvidenceBundle
} from "../../tools/a11y-judge/schema/evidence";

/** Minimal valid bundle covering all three probe types. */
function sampleBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    schemaVersion: 1,
    page: {
      id: "survey-page",
      route: "/course/1/surveys/2",
      title: "Focus Audit Survey",
      viewport: { width: 1280, height: 720 },
      browser: "chromium"
    },
    criterion: "2.4.7",
    collector: { name: "focusIndicator", version: "1.0.0" },
    collectedAt: "2026-07-13T00:00:00.000Z",
    probes: [
      {
        type: "tab-order",
        id: "tab-order-1",
        maxStops: 80,
        wrappedAround: true,
        truncated: false,
        stops: [
          {
            n: 1,
            tag: "input",
            id: "q1",
            role: null,
            ariaLabel: "What is your name?",
            name: "",
            testId: null,
            href: null,
            container: "<main> > <form>",
            x: 100,
            y: 200,
            w: 240,
            h: 32,
            visible: true,
            followsPrevious: true
          }
        ]
      },
      {
        type: "focus-indicator",
        id: "focus-indicator-1",
        stops: [
          {
            n: 1,
            tag: "input",
            role: null,
            name: "Too slow",
            testId: null,
            outline: "solid 2px rgb(0,0,0) offset=2px",
            boxShadow: "none",
            borderColor: "rgb(0,0,0)",
            focusVisibleAttr: true,
            rect: { x: 100, y: 200, w: 20, h: 20 },
            focusedAttachmentId: "att-000-focused.png",
            referenceAttachmentId: "att-001-reference.png"
          }
        ]
      },
      {
        type: "raw-json",
        id: "raw-1",
        label: "ariaSnapshot",
        data: { role: "form", children: [{ role: "textbox", name: "name" }] }
      }
    ],
    attachments: [
      {
        file: "att-000-focused.png",
        sha256: "a".repeat(64),
        mime: "image/png",
        role: "focused-crop",
        probeId: "focus-indicator-1"
      },
      {
        file: "att-001-reference.png",
        sha256: "b".repeat(64),
        mime: "image/png",
        role: "reference-crop",
        probeId: "focus-indicator-1"
      }
    ],
    contentHash: "",
    ...overrides
  };
}

const attachmentHashes = ["a".repeat(64), "b".repeat(64)];

describe("canonical content hash", () => {
  it("is independent of object key insertion order", () => {
    const ordered = { schemaVersion: 1, page: { width: 4, height: 8 }, criterion: "2.4.7" };
    const shuffled = { criterion: "2.4.7", page: { height: 8, width: 4 }, schemaVersion: 1 };
    expect(canonicalizeForHash(ordered)).toBe(canonicalizeForHash(shuffled));
    expect(computeContentHash(ordered, attachmentHashes)).toBe(computeContentHash(shuffled, attachmentHashes));
  });

  it("excludes collectedAt and *Timestamp fields from the hash", () => {
    const base = sampleBundle();
    const later = sampleBundle({ collectedAt: "2099-01-01T00:00:00.000Z" });
    // A nested *Timestamp field inside raw-json data must also be ignored.
    const withTimestampProbe = sampleBundle();
    (withTimestampProbe.probes[2] as { data: unknown }).data = { savedTimestamp: 12345, value: 1 };
    const withDifferentTimestamp = sampleBundle();
    (withDifferentTimestamp.probes[2] as { data: unknown }).data = { savedTimestamp: 99999, value: 1 };

    expect(computeContentHash(base, attachmentHashes)).toBe(computeContentHash(later, attachmentHashes));
    expect(computeContentHash(withTimestampProbe, attachmentHashes)).toBe(
      computeContentHash(withDifferentTimestamp, attachmentHashes)
    );
  });

  it("also ignores the self-referential contentHash field", () => {
    const a = sampleBundle({ contentHash: "" });
    const b = sampleBundle({ contentHash: "deadbeef" });
    expect(computeContentHash(a, attachmentHashes)).toBe(computeContentHash(b, attachmentHashes));
  });

  it("quantizes coordinate fields to a 4px grid (Math.round(v/4)*4)", () => {
    // NOTE: the prompt's illustrative pair "x:101 and x:103 hash equal" does not
    // hold under the specified formula Math.round(v/4)*4 (101->100, 103->104).
    // We honor the explicit formula and assert a pair that genuinely collides
    // (x:100 & x:101 both -> 100) vs one that does not (x:106 -> 108).
    const near = (x: number) => canonicalizeForHash({ rect: { x, y: 0 } });
    expect(near(100)).toBe(near(101));
    expect(near(100)).not.toBe(near(106));

    // Same property at the bundle/hash level via a tab stop's x coordinate.
    const withX = (x: number) => {
      const bundle = sampleBundle();
      (bundle.probes[0] as { stops: { x: number }[] }).stops[0].x = x;
      return computeContentHash(bundle, attachmentHashes);
    };
    expect(withX(100)).toBe(withX(101));
    expect(withX(100)).not.toBe(withX(106));
  });

  it("is sensitive to attachment hashes", () => {
    const bundle = sampleBundle();
    const withA = computeContentHash(bundle, ["a".repeat(64), "b".repeat(64)]);
    const withB = computeContentHash(bundle, ["a".repeat(64), "c".repeat(64)]);
    expect(withA).not.toBe(withB);
  });

  it("sorts attachment hashes so order does not matter", () => {
    const bundle = sampleBundle();
    const forward = computeContentHash(bundle, ["a".repeat(64), "b".repeat(64)]);
    const reversed = computeContentHash(bundle, ["b".repeat(64), "a".repeat(64)]);
    expect(forward).toBe(reversed);
  });
});

describe("EvidenceBundle zod schema", () => {
  it("round-trips a bundle with all three probe types", () => {
    const bundle = sampleBundle({ contentHash: "0".repeat(64) });
    const parsed = EvidenceBundleSchema.parse(bundle);
    expect(parsed.probes.map((p) => p.type)).toEqual(["tab-order", "focus-indicator", "raw-json"]);
    // Re-parsing the parsed value is stable.
    expect(EvidenceBundleSchema.parse(parsed)).toEqual(parsed);
  });

  it("rejects an unknown probe type", () => {
    const bundle = sampleBundle({ contentHash: "0".repeat(64) }) as unknown as {
      probes: unknown[];
    };
    bundle.probes = [{ type: "bogus", id: "x" }];
    expect(() => EvidenceBundleSchema.parse(bundle)).toThrow();
  });
});
