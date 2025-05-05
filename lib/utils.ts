import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDueDate(date: string | null) {
  if (!date) {
    return "N/A";
  }
  return new Date(date).toLocaleDateString() + " " + new Date(date).toLocaleTimeString();
}
