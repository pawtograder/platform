"use client";

import { useState, useMemo, useEffect } from "react";
import { Button, HStack, VStack, Text, Input, Icon, Box } from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { createListCollection } from "@chakra-ui/react";
import { SelectRoot, SelectTrigger, SelectValueText, SelectContent, SelectItem } from "@/components/ui/select";
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverHeader, PopoverBody } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useTableControllerTableValues } from "@/lib/TableController";
import { useParams } from "next/navigation";
import { BsCalendar, BsLink45Deg, BsCheck } from "react-icons/bs";
import { toaster } from "@/components/ui/toaster";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/utils/supabase/client";

export default function CalendarSubscribeButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const { course_id } = useParams();
  const { role } = useClassProfiles();
  const controller = useCourseController();

  // Get available sections
  const classSections = useTableControllerTableValues(controller.classSections);
  const labSections = useTableControllerTableValues(controller.labSections);
  const supabase = createClient();

  // Get user's enrolled sections
  const userClassSectionId = role.class_section_id;
  const userLabSectionId = role.lab_section_id;

  // State for selected sections
  const [selectedClassSectionId, setSelectedClassSectionId] = useState<string>(userClassSectionId?.toString() || "");
  const [selectedLabSectionId, setSelectedLabSectionId] = useState<string>(userLabSectionId?.toString() || "");
  const [copied, setCopied] = useState(false);

  // State for include flags (default to true)
  const [includeOfficeHours, setIncludeOfficeHours] = useState(true);
  const [includeCourseEvents, setIncludeCourseEvents] = useState(true);

  // State for instructor/leader information
  const [classSectionInstructors, setClassSectionInstructors] = useState<Map<number, string[]>>(new Map());
  const [labSectionLeaders, setLabSectionLeaders] = useState<Map<number, string[]>>(new Map());

  // Fetch instructors for class sections
  useEffect(() => {
    const fetchClassSectionInstructors = async () => {
      if (classSections.length === 0) {
        setClassSectionInstructors(new Map());
        return;
      }

      const { data: instructors } = await supabase
        .from("user_roles")
        .select("class_section_id, profiles!private_profile_id(name)")
        .eq("class_id", parseInt(course_id as string))
        .eq("role", "instructor")
        .in(
          "class_section_id",
          classSections.map((s) => s.id).filter((id): id is number => id !== null)
        );

      if (instructors) {
        const map = new Map<number, string[]>();
        instructors.forEach((instructor) => {
          if (instructor.class_section_id) {
            const profileName = (instructor.profiles as { name: string | null })?.name;
            if (profileName) {
              if (!map.has(instructor.class_section_id)) {
                map.set(instructor.class_section_id, []);
              }
              map.get(instructor.class_section_id)!.push(profileName);
            }
          }
        });
        setClassSectionInstructors(map);
      }
    };

    fetchClassSectionInstructors();
  }, [classSections, course_id, supabase]);

  // Fetch leaders for lab sections
  useEffect(() => {
    const fetchLabSectionLeaders = async () => {
      if (labSections.length === 0) {
        setLabSectionLeaders(new Map());
        return;
      }

      const { data: leaders } = await supabase
        .from("lab_section_leaders")
        .select("lab_section_id, profiles(name)")
        .in(
          "lab_section_id",
          labSections.map((s) => s.id)
        );

      if (leaders) {
        const map = new Map<number, string[]>();
        leaders.forEach((leader) => {
          const sectionId = leader.lab_section_id;
          const profileName = (leader.profiles as { name: string | null })?.name;
          if (profileName) {
            if (!map.has(sectionId)) {
              map.set(sectionId, []);
            }
            map.get(sectionId)!.push(profileName);
          }
        });
        setLabSectionLeaders(map);
      }
    };

    fetchLabSectionLeaders();
  }, [labSections, supabase]);

  // Create collections for Select components with CRN and instructor info
  const classSectionCollection = useMemo(() => {
    const items = [
      { value: "", label: "No class section" },
      ...classSections.map((section) => {
        const instructors = classSectionInstructors.get(section.id) || [];
        const instructorText = instructors.length > 0 ? ` - ${instructors.join(", ")}` : "";
        const crnText = section.sis_crn ? ` (CRN: ${section.sis_crn})` : "";
        return {
          value: section.id.toString(),
          label: `${section.name}${crnText}${instructorText}`
        };
      })
    ];
    return createListCollection({ items });
  }, [classSections, classSectionInstructors]);

  const labSectionCollection = useMemo(() => {
    const items = [
      { value: "", label: "No lab section" },
      ...labSections.map((section) => {
        const leaders = labSectionLeaders.get(section.id) || [];
        const leaderText = leaders.length > 0 ? ` - ${leaders.join(", ")}` : "";
        const crnText = section.sis_crn ? ` (CRN: ${section.sis_crn})` : "";
        return {
          value: section.id.toString(),
          label: `${section.name}${crnText}${leaderText}`
        };
      })
    ];
    return createListCollection({ items });
  }, [labSections, labSectionLeaders]);

  // Build the subscription URL
  const subscriptionUrl = useMemo(() => {
    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
    const url = new URL(`/api/calendar/${course_id}`, baseUrl);

    if (selectedClassSectionId) {
      url.searchParams.set("classSection", selectedClassSectionId);
    }
    if (selectedLabSectionId) {
      url.searchParams.set("labSection", selectedLabSectionId);
    }

    // Add include flags (only add if false, since true is the default)
    if (!includeOfficeHours) {
      url.searchParams.set("includeOfficeHours", "false");
    }
    if (!includeCourseEvents) {
      url.searchParams.set("includeCourseEvents", "false");
    }

    return url.toString();
  }, [course_id, selectedClassSectionId, selectedLabSectionId, includeOfficeHours, includeCourseEvents]);

  // Build webcal URL (for calendar apps)
  const webcalUrl = useMemo(() => {
    return subscriptionUrl.replace(/^https?:/, "webcal:");
  }, [subscriptionUrl]);

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(webcalUrl);
      setCopied(true);
      toaster.create({
        title: "Copied!",
        description: "Calendar subscription URL copied to clipboard",
        type: "success"
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      Sentry.captureException(_error);
      toaster.create({
        title: "Failed to copy",
        description: "Please copy the URL manually",
        type: "error"
      });
    }
  };

  const button = (
    <Button size="xs" variant="outline" colorPalette="blue">
      <Icon as={BsCalendar} {...(iconOnly ? {} : { mr: 1 })} />
      {!iconOnly && "Subscribe"}
    </Button>
  );

  return (
    <PopoverRoot>
      {iconOnly ? (
        <Tooltip content="Subscribe to calendar">
          <Box display="inline-block">
            <PopoverTrigger asChild>{button}</PopoverTrigger>
          </Box>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{button}</PopoverTrigger>
      )}
      <PopoverContent width="400px">
        <PopoverHeader>Subscribe to Calendar</PopoverHeader>
        <PopoverBody>
          <VStack align="stretch" gap={4}>
            <Text fontSize="sm" color="fg.muted">
              Subscribe to this course calendar in your calendar app (Google Calendar, Apple Calendar, Outlook, etc.)
            </Text>

            {/* Class Section Selector */}
            {classSections.length > 0 && (
              <Box>
                <Text fontSize="xs" fontWeight="medium" mb={1}>
                  Class Section (optional)
                </Text>
                <SelectRoot
                  collection={classSectionCollection}
                  value={selectedClassSectionId ? [selectedClassSectionId] : []}
                  onValueChange={(details) => setSelectedClassSectionId(details.value[0] || "")}
                >
                  <SelectTrigger>
                    <SelectValueText placeholder="No class section" />
                  </SelectTrigger>
                  <SelectContent style={{ zIndex: 10000 }}>
                    {classSectionCollection.items.map((item) => (
                      <SelectItem key={item.value} item={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </Box>
            )}

            {/* Lab Section Selector */}
            {labSections.length > 0 && (
              <Box>
                <Text fontSize="xs" fontWeight="medium" mb={1}>
                  Lab Section (optional)
                </Text>
                <SelectRoot
                  collection={labSectionCollection}
                  value={selectedLabSectionId ? [selectedLabSectionId] : []}
                  onValueChange={(details) => setSelectedLabSectionId(details.value[0] || "")}
                >
                  <SelectTrigger>
                    <SelectValueText placeholder="No lab section" />
                  </SelectTrigger>
                  <SelectContent style={{ zIndex: 10000 }}>
                    {labSectionCollection.items.map((item) => (
                      <SelectItem key={item.value} item={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </Box>
            )}

            {/* Include Flags */}
            <Box>
              <Text fontSize="xs" fontWeight="medium" mb={2}>
                Include in calendar:
              </Text>
              <VStack align="stretch" gap={2}>
                <Checkbox
                  checked={includeOfficeHours}
                  onCheckedChange={(details) => setIncludeOfficeHours(details.checked === true)}
                >
                  <Text fontSize="xs">Include office hours</Text>
                </Checkbox>
                <Checkbox
                  checked={includeCourseEvents}
                  onCheckedChange={(details) => setIncludeCourseEvents(details.checked === true)}
                >
                  <Text fontSize="xs">Include course events</Text>
                </Checkbox>
              </VStack>
            </Box>

            {/* URL Display */}
            <Box>
              <Text fontSize="xs" fontWeight="medium" mb={1}>
                Subscription URL
              </Text>
              <HStack gap={2}>
                <Input
                  value={webcalUrl}
                  readOnly
                  fontSize="xs"
                  fontFamily="mono"
                  flex={1}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Button
                  size="xs"
                  variant={copied ? "solid" : "outline"}
                  colorPalette={copied ? "green" : "blue"}
                  onClick={handleCopyUrl}
                  aria-label="Copy URL"
                >
                  <Icon as={copied ? BsCheck : BsLink45Deg} />
                </Button>
              </HStack>
            </Box>

            {/* Instructions */}
            <Box>
              <Text fontSize="xs" color="fg.muted" fontWeight="medium" mb={1}>
                How to subscribe:
              </Text>
              <VStack align="stretch" gap={1} fontSize="xs" color="fg.muted">
                <Text>1. Copy the URL above</Text>
                <Text>2. Open your calendar app</Text>
                <Text>3. Add calendar by URL</Text>
                <Text>4. Paste the URL</Text>
              </VStack>
            </Box>
          </VStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
