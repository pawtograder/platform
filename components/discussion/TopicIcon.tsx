"use client";

import { Icon } from "@chakra-ui/react";
import type { IconType } from "react-icons";
import {
  FaBook,
  FaBug,
  FaChalkboardTeacher,
  FaClipboardList,
  FaCode,
  FaComments,
  FaFlask,
  FaGraduationCap,
  FaLaptopCode,
  FaLightbulb,
  FaQuestionCircle,
  FaRegStickyNote,
  FaSitemap,
  FaUserFriends
} from "react-icons/fa";
import { BsChatDots, BsPinAngleFill } from "react-icons/bs";

export const TOPIC_ICON_OPTIONS = [
  { value: "FaComments", label: "Discussion", icon: FaComments },
  { value: "BsChatDots", label: "Chat", icon: BsChatDots },
  { value: "FaQuestionCircle", label: "Q&A", icon: FaQuestionCircle },
  { value: "FaRegStickyNote", label: "Notes", icon: FaRegStickyNote },
  { value: "FaBug", label: "Bugs", icon: FaBug },
  { value: "FaCode", label: "Code", icon: FaCode },
  { value: "FaLaptopCode", label: "Programming", icon: FaLaptopCode },
  { value: "FaFlask", label: "Lab", icon: FaFlask },
  { value: "FaClipboardList", label: "Homework", icon: FaClipboardList },
  { value: "FaBook", label: "Reading", icon: FaBook },
  { value: "FaGraduationCap", label: "Exam", icon: FaGraduationCap },
  { value: "FaChalkboardTeacher", label: "Staff", icon: FaChalkboardTeacher },
  { value: "FaUserFriends", label: "Study group", icon: FaUserFriends },
  { value: "FaLightbulb", label: "Tips", icon: FaLightbulb },
  { value: "FaSitemap", label: "Logistics", icon: FaSitemap },
  { value: "BsPinAngleFill", label: "Announcements", icon: BsPinAngleFill }
] as const;

export type TopicIconName = (typeof TOPIC_ICON_OPTIONS)[number]["value"];

const ICON_MAP: Record<TopicIconName, IconType> = TOPIC_ICON_OPTIONS.reduce(
  (acc, opt) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (acc as any)[opt.value] = opt.icon;
    return acc;
  },
  {} as Record<TopicIconName, IconType>
);

export function TopicIcon({ name, color, boxSize }: { name?: string | null; color?: string; boxSize?: string }) {
  if (!name) return null;
  const icon = (ICON_MAP as Record<string, IconType | undefined>)[name];
  if (!icon) return null;
  return <Icon as={icon} color={color} boxSize={boxSize ?? "4"} />;
}
