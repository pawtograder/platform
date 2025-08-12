### Rubrics: Instructor Guide

This guide explains how rubrics drive the hand‑grading experience and how scores are computed. It also includes copy‑pasteable YAML examples for each configuration option.

## High‑level overview
- **Rubric**: Named collection of parts used for a specific review round (self‑review, grading‑review, meta‑grading‑review).
- **Part**: Logical section within a rubric (e.g., Code Quality, Functionality). Contains criteria.
- **Criteria**: A scoring rule block with:
  - `is_additive`: If true, checks add points up to `total_points`. If false, checks deduct points from `total_points`.
  - `total_points`: Max points for this criteria.
  - `min_checks_per_submission` / `max_checks_per_submission`: How many checks must/can be applied for the criteria.
  - One or more checks.
- **Check**: The atom of feedback and scoring. A check can be global or an annotation applied to a file line or to an artifact. Checks can have:
  - `points` or selectable `data.options` with distinct labels/points
  - `is_annotation` + `annotation_target` (`file` or `artifact`), optional `file`/`artifact` to link
  - `is_required`: Must be applied by graders
  - `is_comment_required`: Comment is required when applying
  - `max_annotations`: Cap on times a check may be applied as annotations
  - `student_visibility`: `always` | `if_applied` | `if_released` | `never`

Where this shows up in the hand‑grader:
- The right‑hand panel is the rubric sidebar. Global checks render as radio/checkbox options. Annotation checks are applied from the code view or artifact cards by right‑clicking a line or selecting an artifact.
- Each applied check creates a comment entry tied to a check with points and optional text.
- For each criteria, the sidebar shows a running subtotal.

How points are computed:
- Per criteria:
  - If `is_additive = true`: criteria score = sum(applied check points) up to `total_points`.
  - If `is_additive = false`: criteria score = `total_points - sum(applied deduction points)` (floored at 0).
- The rubric total is the sum across criteria. Release state and visibility only affect what students can see, not the computed score.

Note on options vs base points:
- If a check has `data.options`, the selected option’s `points` replaces the check’s base `points` when applied.
- Options must be 2+ (single options are disallowed by the editor and schema).

References across rubrics:
- Checks can reference checks from other rubrics to surface related feedback when grading. This is managed inline in the sidebar (preview mode).

## YAML schema quick reference
These examples conform to `public/RubricSchema.json`.

### Minimal rubric
```yaml
name: Sample Rubric
parts:
  - name: Code Quality
    criteria:
      - name: Style and Clarity
        total_points: 10
        is_additive: false
        checks:
          - name: Missing Javadocs
            is_annotation: false
            is_required: false
            is_comment_required: false
            points: 2
          - name: Poor variable naming
            is_annotation: true
            annotation_target: file
            is_required: false
            is_comment_required: true
            max_annotations: 3
            points: 1
```

### Additive vs subtractive criteria
```yaml
name: Additive vs Subtractive
parts:
  - name: Functionality
    criteria:
      - name: Passing tests (additive)
        total_points: 20
        is_additive: true
        checks:
          - name: Public API works
            is_annotation: false
            is_required: false
            is_comment_required: false
            points: 5
          - name: Edge cases handled
            is_annotation: false
            is_required: false
            is_comment_required: false
            points: 5
      - name: Style deductions (subtractive)
        total_points: 10
        is_additive: false
        checks:
          - name: Magic numbers
            is_annotation: true
            annotation_target: file
            is_required: false
            is_comment_required: false
            points: 1
          - name: Redundant code
            is_annotation: true
            annotation_target: file
            is_required: false
            is_comment_required: true
            points: 2
```

### Check with options (multiple choice)
```yaml
name: Options Example
parts:
  - name: API Correctness
    criteria:
      - name: HTTP response quality
        total_points: 10
        is_additive: true
        checks:
          - name: Response completeness
            is_annotation: false
            is_required: true
            is_comment_required: false
            points: 0
            data:
              options:
                - label: Complete and correct
                  points: 5
                - label: Mostly complete
                  points: 3
                - label: Incomplete
                  points: 1
```

### Annotations (file vs artifact) and limits
```yaml
name: Annotation Targets
parts:
  - name: Docs and Reports
    criteria:
      - name: README quality (deductions)
        total_points: 5
        is_additive: false
        checks:
          - name: Missing section
            is_annotation: true
            annotation_target: artifact
            artifact: README.md
            is_comment_required: true
            is_required: false
            max_annotations: 2
            points: 1
      - name: Code comments
        total_points: 5
        is_additive: false
        checks:
          - name: Unclear comment
            is_annotation: true
            annotation_target: file
            file: src/Main.java
            points: 1
```

### Required checks and required comments
```yaml
name: Requireds
parts:
  - name: Process
    criteria:
      - name: Submission hygiene
        total_points: 5
        is_additive: true
        checks:
          - name: Compiles
            is_annotation: false
            is_required: true       # graders must apply
            is_comment_required: false
            points: 5
          - name: Explain deviation
            is_annotation: false
            is_required: false
            is_comment_required: true  # applying this check requires a comment
            points: 0
```

### Min/Max checks per criteria
```yaml
name: Min/Max Checks
parts:
  - name: Code Review
    criteria:
      - name: Choose exactly one pattern
        total_points: 5
        is_additive: true
        min_checks_per_submission: 1
        max_checks_per_submission: 1
        checks:
          - name: Builder pattern used
            is_annotation: false
            points: 5
          - name: Strategy pattern used
            is_annotation: false
            points: 5
      - name: Choose up to two strengths
        total_points: 4
        is_additive: true
        max_checks_per_submission: 2
        checks:
          - name: Test readability
            is_annotation: false
            points: 2
          - name: Modular design
            is_annotation: false
            points: 2
```

### Student visibility
```yaml
name: Visibility
parts:
  - name: Feedback
    criteria:
      - name: Public notes
        total_points: 0
        is_additive: true
        checks:
          - name: General praise
            is_annotation: false
            points: 0
            student_visibility: always
      - name: Internal notes
        total_points: 0
        is_additive: true
        checks:
          - name: For staff only
            is_annotation: false
            points: 0
            student_visibility: never
      - name: Released only
        total_points: 0
        is_additive: true
        checks:
          - name: Visible when released
            is_annotation: false
            points: 0
            student_visibility: if_released
      - name: Only if applied
        total_points: 0
        is_additive: true
        checks:
          - name: Shown when applied
            is_annotation: false
            points: 0
            student_visibility: if_applied
```

## How this renders in the hand‑grader
- Global checks appear as radio buttons (when `max_checks_per_submission = 1`) or checkboxes (otherwise).
- Checks with `data.options` render a choice list. The selected option’s label is prefixed to the comment.
- Annotation checks are applied via right‑click on a code line or by selecting an artifact.
- For each criteria, the sidebar shows:
  - Additive: `earned / total_points`
  - Subtractive: `remaining / total_points`

## Notes and tips
- Keep criteria focused and keep check names short; longer explanation should go in `description`.
- Use `max_annotations` to prevent over‑counting nitpicks.
- Prefer options when the same check has graded tiers (e.g., Complete/Partial/Incomplete).
- Use `student_visibility` to separate internal notes from student‑facing feedback.