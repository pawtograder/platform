"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { HStack, NativeSelect, Spinner } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useState } from "react";

/** Provisions an instructor enrollment for the admin (idempotent), then opens the course. */
async function enterCourse(classId: number, router: ReturnType<typeof useRouter>, onError: () => void) {
  const supabase = createClient();
  try {
    const { error } = await supabase.rpc("admin_enter_course_as_instructor", { p_class_id: classId });
    if (error) throw error;
    router.push(`/course/${classId}/manage/assignments`);
  } catch (err) {
    const description = err instanceof Error ? err.message : "Unknown error";
    toaster.error({ title: "Failed to enter course", description });
    onError();
  }
}

export function EnterCourseAsInstructorButton({
  classId,
  children,
  size = "sm",
  variant = "ghost"
}: {
  classId: number;
  children: ReactNode;
  size?: string;
  variant?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const onClick = useCallback(async () => {
    setLoading(true);
    await enterCourse(classId, router, () => setLoading(false));
  }, [classId, router]);
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Button size={size as any} variant={variant as any} onClick={onClick} loading={loading}>
      {children}
    </Button>
  );
}

type AdminClass = { id: number; name: string | null; term: number | null };

/** Quick course switcher: pick any class and jump into it as an instructor. */
export function AdminCoursePicker() {
  const router = useRouter();
  const [classes, setClasses] = useState<AdminClass[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [entering, setEntering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.rpc("admin_get_classes");
        if (cancelled) return;
        if (error) {
          toaster.error({ title: "Failed to load classes", description: error.message });
          setClasses([]);
          return;
        }
        const rows = (data ?? []).map((c) => ({ id: c.id, name: c.name, term: c.term }));
        setClasses(rows);
        if (rows.length > 0) setSelected(String(rows[0].id));
      } catch (e) {
        if (!cancelled) {
          console.warn("AdminCoursePicker: failed to load classes", e);
          setClasses([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onEnter = useCallback(async () => {
    const classId = Number(selected);
    if (!classId) return;
    setEntering(true);
    await enterCourse(classId, router, () => setEntering(false));
  }, [selected, router]);

  if (classes === null) {
    return <Spinner size="sm" />;
  }

  return (
    <HStack gap={2} w="full" data-testid="admin-course-picker">
      <NativeSelect.Root size="sm" flex={1}>
        <NativeSelect.Field
          aria-label="Select a course to manage as instructor"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? `Class ${c.id}`}
              {c.term ? ` (${c.term})` : ""}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      <Button size="sm" onClick={onEnter} loading={entering} disabled={!selected}>
        Manage as instructor
      </Button>
    </HStack>
  );
}
