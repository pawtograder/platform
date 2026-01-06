# Seed Course Assignments Script

This script creates placeholder assignments and gradebook columns in Pawtograder from a course configuration file.

## What It Creates

| Type              | Source               | Release Date                | Due Date                 |
| ----------------- | -------------------- | --------------------------- | ------------------------ |
| **Homework**      | `config.assignments` | `assignedDate` at 00:00     | `dueDate` at `dueTime`   |
| **Labs**          | `config.labs`        | Monday 00:00 of lab week    | Friday 23:59 of lab week |
| **Participation** | `config.lectures`    | N/A (gradebook column only) | N/A                      |

- **Homework and Labs** are created as assignments with release and due dates
- **Participation** is created as gradebook columns (not assignments) for manual grade entry

## Prerequisites

1. A course configuration file (e.g., `course.config.json`)
2. An existing class in Pawtograder with a known `class_id`
3. Environment variables configured in `.env.local` (Supabase credentials)

## Usage

```bash
npm run seed:course-assignments -- [options]
```

### Required Options

| Option            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `--class-id <id>` | The Pawtograder class ID to create assignments for |

### Optional Options

| Option                       | Description                                | Default              |
| ---------------------------- | ------------------------------------------ | -------------------- |
| `-c, --config <path>`        | Path to course config file                 | `course.config.json` |
| `--participation-points <n>` | Points for each participation column       | `5`                  |
| `--lab-points <n>`           | Points for each lab assignment             | `10`                 |
| `-s, --skip <id>`            | Skip creating a specific item (repeatable) | —                    |
| `--dry-run`                  | Preview without creating anything          | —                    |
| `-h, --help`                 | Show help message                          | —                    |

## Examples

### Preview What Would Be Created

```bash
npm run seed:course-assignments -- --class-id 123 --dry-run
```

### Create All Assignments with Defaults

```bash
npm run seed:course-assignments -- --class-id 123
```

### Custom Points Configuration

```bash
npm run seed:course-assignments -- --class-id 123 \
  --participation-points 3 \
  --lab-points 20
```

### Skip Specific Items

```bash
# Skip a homework assignment
npm run seed:course-assignments -- --class-id 123 --skip cyb1

# Skip multiple items
npm run seed:course-assignments -- --class-id 123 \
  --skip cyb1 \
  --skip lab1 \
  --skip l1-intro

# Short form
npm run seed:course-assignments -- --class-id 123 -s cyb1 -s team-form
```

### Use a Different Config File

```bash
npm run seed:course-assignments -- --class-id 123 --config /path/to/other-course.json
```

## Skip IDs Reference

The `--skip` flag uses different ID formats depending on the item type:

| Type          | ID Source                                | Examples                     |
| ------------- | ---------------------------------------- | ---------------------------- |
| Homework      | `assignments[].id` in config             | `cyb1`, `team-form`, `cyb2`  |
| Labs          | `labs[].id` without `-mon`/`-tue` suffix | `lab1`, `lab2`, `lab3`       |
| Participation | `lectures[].lectureId` in config         | `l1-intro`, `l2-data-in-jvm` |

## Course Config File Format

The script expects a JSON file with the following structure:

```json
{
  "courseCode": "CS 3100",
  "courseTitle": "Program Design and Implementation II",
  "semester": "Spring 2026",
  "timezone": "America/New_York",
  "startDate": "2026-01-07",
  "endDate": "2026-04-20",
  "lectures": [
    {
      "lectureId": "l1-intro",
      "dates": ["2026-01-07"],
      "topics": ["Course Overview and Introduction to Java"]
    }
  ],
  "labs": [
    {
      "id": "lab1-mon",
      "title": "Lab 1: Java Tooling and Setup",
      "dates": ["2026-01-07"],
      "sections": ["L05", "L06"]
    }
  ],
  "assignments": [
    {
      "id": "cyb1",
      "title": "Assignment 1: Recipe Domain Model",
      "type": "homework",
      "assignedDate": "2026-01-08",
      "dueDate": "2026-01-15",
      "dueTime": "23:59",
      "points": 40
    }
  ]
}
```

## Behavior Notes

### Duplicate Prevention

The script checks for existing assignments and gradebook columns by slug before creating. If an item already exists, it will be skipped (not updated or duplicated).

### Lab Deduplication

Labs with `-mon` and `-tue` suffixes (e.g., `lab1-mon`, `lab1-tue`) are automatically deduplicated. Only one assignment is created per unique base lab ID.

### Timezone Handling

All dates are converted to/from the timezone specified in the config file. Release dates are set to 00:00 and due dates to 23:59 in that timezone.

### Minimal Assignments

Created assignments are minimal placeholders with:

- No autograder or handgrader
- No rubric
- Self-review disabled
- Group config set to "individual"
- Late tokens set to 0

These can be configured further in the Pawtograder UI after creation.

## Troubleshooting

### "Failed to get gradebook for class"

The class doesn't have a gradebook. This usually means the class was created incorrectly. Each class should automatically get a gradebook on creation.

### "Course config not found"

Check that the config file path is correct. Use an absolute path or ensure the relative path is from the project root.

### Items Not Being Created

1. Check if they already exist (the script skips duplicates)
2. Verify the item isn't in the `--skip` list
3. Use `--dry-run` to see what would be created
