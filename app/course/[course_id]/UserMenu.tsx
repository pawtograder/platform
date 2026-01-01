"use client";

import NotificationPreferences from "@/components/notifications/notification-preferences";
import NotificationsBox from "@/components/notifications/notifications-box";
import { TimeZoneSelector } from "@/components/TimeZoneSelector";
import { Button } from "@/components/ui/button";
import { ColorModeButton } from "@/components/ui/color-mode";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "@/components/ui/link";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useObfuscatedGradesMode, useSetObfuscatedGradesMode } from "@/hooks/useCourseController";
import { useAutomaticRealtimeConnectionStatus } from "@/hooks/useRealtimeConnectionStatus";
import { useTimeZone } from "@/lib/TimeZoneProvider";
import { createClient } from "@/utils/supabase/client";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import {
  Avatar,
  Box,
  CloseButton,
  Dialog,
  Drawer,
  Flex,
  Heading,
  HStack,
  IconButton,
  Menu,
  Portal,
  Text,
  VStack
} from "@chakra-ui/react";
import { FiClock } from "react-icons/fi";

import { useInvalidate, useOne } from "@refinedev/core";
import { useParams, useSearchParams } from "next/navigation";
import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaGithub } from "react-icons/fa";
import { FaCircleUser } from "react-icons/fa6";
import { HiOutlineSupport } from "react-icons/hi";
import { LuCheck, LuCopy } from "react-icons/lu";
import { PiSignOut } from "react-icons/pi";
import { RiChatSettingsFill } from "react-icons/ri";
import { TbSpy, TbSpyOff } from "react-icons/tb";
import { signOutAction } from "../../actions";

function SupportMenu() {
  // Track whether the build number has been successfully copied
  const [isCopied, setIsCopied] = useState(false);

  // Store timeout ID to enable cleanup and prevent memory leaks
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const buildNumber = useMemo(() => {
    const str =
      process.env.SENTRY_RELEASE ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.NEXT_PUBLIC_GIT_COMMIT_SHA ??
      process.env.npm_package_version;
    if (str) {
      return str.substring(0, 7);
    }
    return "Unknown";
  }, []);

  const { course_id } = useParams();

  // Cleanup: Clear timeout when component unmounts to prevent memory leaks
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  /**
   * Copies the build number to clipboard and shows visual feedback.
   * Prevents menu from closing and displays error toast if copy fails.
   */
  const handleCopyBuildNumber = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Clear any existing timeout to prevent multiple timers running
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    try {
      // Copy build number to clipboard using Clipboard API
      await navigator.clipboard.writeText(buildNumber);
      setIsCopied(true);

      // Reset visual feedback after 2 seconds
      timeoutRef.current = setTimeout(() => {
        setIsCopied(false);
        timeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error("Failed to copy build number:", err);
      // Show user-friendly error notification
      toaster.error({
        title: "Failed to copy build number",
        description: err instanceof Error ? err.message : "An unknown error occurred"
      });
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton variant="outline" colorPalette="blue" size="sm" aria-label="Support & Documentation">
          <HiOutlineSupport />
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.Item value="github-help">
              <Link href={`/course/${course_id}/github-help`}>
                <FaGithub /> GitHub Help
              </Link>
            </Menu.Item>
            <Menu.Item value="view-docs">
              <Link href={"https://docs.pawtograder.com"} target="_blank">
                View documentation
              </Link>
            </Menu.Item>
            <Menu.Item value="report-feature-request">
              <Link
                href={
                  "https://github.com/pawtograder/platform/issues/new?labels=enhancement&template=feature_request.md"
                }
                target="_blank"
              >
                Request a feature
              </Link>
            </Menu.Item>
            <Menu.Item value="report-bug">
              <Link
                href={"https://github.com/pawtograder/platform/issues/new?labels=bug&template=bug_report.md"}
                target="_blank"
              >
                Report a bug
              </Link>
            </Menu.Item>
            <Menu.Item value="view-open-bugs">
              <Link href={"https://github.com/pawtograder/platform/issues?q=is%3Aissue%20state%3Aopen"} target="_blank">
                View open issues
              </Link>
            </Menu.Item>
            <Menu.Item
              value="current-version"
              onClick={handleCopyBuildNumber}
              closeOnSelect={false}
              cursor="pointer"
              _hover={{ bg: "bg.subtle" }}
              aria-label="Copy build number to clipboard"
            >
              <HStack gap={2} width="100%" justifyContent="space-between">
                <Text>Build: {buildNumber}</Text>
                {isCopied ? (
                  <Box color="green.500">
                    <LuCheck size={16} />
                  </Box>
                ) : (
                  <LuCopy size={16} />
                )}
              </HStack>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

const DropBoxAvatar = ({
  avatarLink,
  setAvatarLink,
  avatarType,
  profile
}: {
  avatarLink: string | null | undefined;
  setAvatarLink: Dispatch<SetStateAction<string | null>>;
  avatarType: string;
  profile: UserProfile | null;
}) => {
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const supabase = useMemo(() => createClient(), []);
  const { course_id } = useParams();
  const { user } = useAuthState();

  /**
   * Uploads user image to avatar storage bucket under avatars/[userid]/[courseid]/uuid.extension
   * @param file jpg or png image file for new avatar
   */
  const completeAvatarUpload = useCallback(
    async (file: File) => {
      if (!profile || !user) {
        return;
      }
      const uuid = crypto.randomUUID();
      const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, "_");
      const fileExtension = fileName.split(".").pop();
      const { data, error } = await supabase.storage
        .from("avatars")
        .upload(`${user?.id}/${course_id}/${uuid}.${fileExtension}`, file);

      if (!data || error) {
        toaster.error({
          title: "Error uploading avatar image",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      } else {
        setAvatarLink(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/avatars/${user?.id}/${course_id}/${uuid}.${fileExtension}`
        );
      }
    },
    [course_id, profile, setAvatarLink, supabase.storage, user]
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        return;
      }
      const file = files[0];
      if (file.type === "image/jpeg" || file.type === "image/png") {
        completeAvatarUpload(file);
      } else {
        alert("Please upload a valid JPEG or PNG image file.");
      }
      // Reset the input value so the same file can be selected again if needed
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [completeAvatarUpload]
  );

  return (
    <>
      <input
        title="Avatar upload"
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/jpeg,image/png"
        onChange={handleFileChange}
      />
      <Toaster />
      <Flex alignItems="center" justifyContent={"center"} flexDirection="column" gap="5px">
        <Box position="relative" width="100px" height="100px">
          <Menu.Root positioning={{ placement: "bottom" }}>
            <Text fontWeight={"700"}>{avatarType} Avatar</Text>
            <Menu.Trigger asChild>
              <Button background="transparent" height="100%" width="100%" borderRadius={"full"}>
                <Avatar.Root
                  colorPalette="gray"
                  width="100px"
                  height="100px"
                  _hover={{
                    boxShadow: "0px 4px 4px rgba(0, 0, 0, 0.25)",
                    background: "rgba(0, 0, 0, 0.5)",
                    opacity: 0.2,
                    zIndex: 10
                  }}
                  onMouseEnter={() => setIsHovered(true)}
                  onMouseLeave={() => setIsHovered(false)}
                >
                  <Avatar.Image src={avatarLink || undefined} />
                  <Avatar.Fallback name={profile?.name?.charAt(0) ?? "?"} />
                </Avatar.Root>
                {isHovered && (
                  <Flex
                    position="absolute"
                    w="100%"
                    h="100%"
                    top="0"
                    alignItems="center"
                    justifyContent="center"
                    color="black"
                    fontWeight={700}
                    _hover={{
                      opacity: 1,
                      zIndex: 20
                    }}
                  >
                    <Text textAlign={"center"}>Edit Avatar</Text>
                  </Flex>
                )}
              </Button>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content>
                <Menu.Item
                  value="new-img"
                  onClick={() => {
                    fileInputRef?.current?.click();
                  }}
                >
                  Choose from computer
                </Menu.Item>
                <Menu.Item
                  value="delete"
                  color="fg.error"
                  _hover={{ bg: "bg.error", color: "fg.error" }}
                  onClick={() => {
                    const safeSeed = profile?.id || user?.id || "default";
                    setAvatarLink(`https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(safeSeed)}`);
                  }}
                >
                  Remove current picture
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </Box>
      </Flex>
    </>
  );
};

/**
 * Modal that handles user profile updates, currently only avatar changes.
 */
const ProfileChangesMenu = () => {
  const [publicAvatarLink, setPublicAvatarLink] = useState<string | null>(null);
  const [privateAvatarLink, setPrivateAvatarLink] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const supabase = useMemo(() => createClient(), []);
  const { course_id } = useParams();
  const { user } = useAuthState();
  const invalidate = useInvalidate();
  const { private_profile_id, public_profile_id } = useClassProfiles();

  const { data: privateProfile } = useOne<UserProfile>({
    resource: "profiles",
    id: private_profile_id
  });

  const { data: publicProfile } = useOne<UserProfile>({
    resource: "profiles",
    id: public_profile_id
  });

  useEffect(() => {
    if (publicProfile) {
      setPublicAvatarLink(publicProfile?.data.avatar_url);
    }
    if (privateProfile) {
      setPrivateAvatarLink(privateProfile?.data.avatar_url);
      setName(privateProfile?.data.name ?? "");
    }
  }, [publicProfile, privateProfile]);

  /**
   * Updates user profile on "Save" by replacing avatar_url and name in database with new file.
   * Removes extra files in user's avatar storage bucket.
   */
  const updateProfile = async () => {
    removeUnusedImages(privateAvatarLink ?? null, publicAvatarLink ?? null);
    if (publicAvatarLink && publicProfile) {
      const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: publicAvatarLink })
        .eq("id", publicProfile.data.id)
        .single();
      if (error) {
        toaster.error({
          title: "Error updating user public profile",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      }
    }
    if (privateAvatarLink && privateProfile) {
      const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: privateAvatarLink })
        .eq("id", privateProfile.data.id)
        .single();
      if (error) {
        toaster.error({
          title: "Error updating user private profile",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      }
    }

    if (privateProfile) {
      const trimmedName = name?.trim() || "";
      if (trimmedName.length === 0) {
        toaster.error({
          title: "Invalid preferred name",
          description: "Preferred name cannot be empty or only whitespace"
        });
        return;
      }
      const { error } = await supabase
        .from("profiles")
        .update({ name: trimmedName })
        .eq("id", privateProfile.data.id)
        .single();
      if (error) {
        toaster.error({
          title: "Error updating preferred name",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      }
    }

    invalidate({
      resource: "profiles",
      invalidates: ["list", "detail"],
      id: publicProfile?.data.id
    });
    invalidate({
      resource: "profiles",
      invalidates: ["list", "detail"],
      id: privateProfile?.data.id
    });
  };
  /**
   * Removes extra images from storage that may have been populated if the user attempted to open the menu and reselect multiple times.
   */
  const removeUnusedImages = async (privateLink: string | null, publicLink: string | null) => {
    const { data: storedImages, error } = await supabase.storage.from("avatars").list(`${user?.id}/${course_id}`);
    if (!storedImages || error) {
      toaster.error({
        title: "Error finding stored images",
        description: error instanceof Error ? error.message : "An unknown error occurred"
      });

      return;
    }
    const pathsToRemove = storedImages
      .filter((image) => !publicLink?.includes(image.name) && !privateLink?.includes(image.name))
      .map((imageToRemove) => `${user?.id}/${course_id}/${imageToRemove.name}`);
    if (pathsToRemove.length > 0) {
      const { error: removeError } = await supabase.storage.from("avatars").remove(pathsToRemove);
      if (removeError) {
        toaster.error({
          title: "Error removing extra files from storage",
          description: removeError instanceof Error ? removeError.message : "An unknown error occurred"
        });
      }
    }
  };

  return (
    <>
      <Toaster />
      <Dialog.Root size={"md"} placement={"center"}>
        <Dialog.Trigger asChild>
          <Button
            variant="ghost"
            colorPalette={"gray"}
            width="100%"
            justifyContent="flex-start"
            size="sm"
            textAlign="left"
            py={0}
          >
            <FaCircleUser />
            Edit Profile
          </Button>
        </Dialog.Trigger>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Edit Profile</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Flex flexDirection={"column"} gap="50px">
                  <Flex flexDirection={"column"} gap="4">
                    <Heading as="h3" size="md">
                      Preferred Name
                    </Heading>
                    <Label htmlFor="preferred-name">Enter Your Preferred Name</Label>
                    <Input
                      value={name}
                      id="preferred-name"
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Enter your preferred name"
                    />
                  </Flex>

                  <Flex flexDirection={"column"} gap="4">
                    <Heading as="h3" size="md">
                      Avatars
                    </Heading>
                    <Flex alignItems="center" justifyContent={"center"} gap="30px" flexWrap={"wrap"}>
                      <DropBoxAvatar
                        avatarLink={publicAvatarLink}
                        setAvatarLink={setPublicAvatarLink}
                        avatarType="Public"
                        profile={publicProfile?.data ?? null}
                      />
                      <DropBoxAvatar
                        avatarLink={privateAvatarLink}
                        setAvatarLink={setPrivateAvatarLink}
                        avatarType="Private"
                        profile={privateProfile?.data ?? null}
                      />
                    </Flex>
                    <Text fontSize="sm" color="fg.muted" mt={6}>
                      Your public avatar will be used on anonymous posts along with your pseudonym, &quot;
                      {publicProfile?.data.name}&quot;.
                    </Text>
                  </Flex>
                </Flex>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPrivateAvatarLink(privateProfile?.data.avatar_url ?? null);
                      setPublicAvatarLink(publicProfile?.data.avatar_url ?? null);
                      setName(privateProfile?.data.name ?? "");
                      removeUnusedImages(
                        privateProfile?.data.avatar_url ?? null,
                        publicProfile?.data.avatar_url ?? null
                      );
                    }}
                  >
                    Cancel
                  </Button>
                </Dialog.ActionTrigger>
                <Dialog.ActionTrigger asChild>
                  <Button onClick={updateProfile} colorPalette="green">
                    Save
                  </Button>
                </Dialog.ActionTrigger>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
};

/**
 * Dialog component to allow users to manage their notification preferences.
 * Supports deep-linking via URL parameters:
 * - ?openNotificationSettings=true - Opens the modal
 * - ?setDiscussionNotification=disabled - Sets discussion notification preference and opens modal
 */
const NotificationPreferencesMenu = () => {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  // Validate URL parameter against allowed values
  const initialDiscussionNotification = useMemo<"immediate" | "digest" | "disabled" | null>(() => {
    const rawNotificationParam = searchParams.get("setDiscussionNotification");
    const allowedValues: readonly ("immediate" | "digest" | "disabled")[] = ["immediate", "digest", "disabled"];

    if (rawNotificationParam) {
      if (allowedValues.includes(rawNotificationParam as "immediate" | "digest" | "disabled")) {
        return rawNotificationParam as "immediate" | "digest" | "disabled";
      } else {
        // Fall back to "immediate" if param exists but is invalid
        return "immediate";
      }
    }

    return null;
  }, [searchParams]);

  // Open modal if URL parameter is present
  useEffect(() => {
    // Derive notification value from searchParams inside effect to avoid double execution
    const rawNotificationParam = searchParams.get("setDiscussionNotification");
    const allowedValues: readonly ("immediate" | "digest" | "disabled")[] = ["immediate", "digest", "disabled"];
    let notificationValue: "immediate" | "digest" | "disabled" | null = null;

    if (rawNotificationParam) {
      if (allowedValues.includes(rawNotificationParam as "immediate" | "digest" | "disabled")) {
        notificationValue = rawNotificationParam as "immediate" | "digest" | "disabled";
      } else {
        // Fall back to "immediate" if param exists but is invalid
        notificationValue = "immediate";
      }
    }

    if (searchParams.get("openNotificationSettings") === "true" || notificationValue) {
      setOpen(true);
      // Clean up URL params after opening
      const params = new URLSearchParams(searchParams.toString());
      params.delete("openNotificationSettings");
      if (notificationValue) {
        params.delete("setDiscussionNotification");
      }
      const newUrl = params.toString() ? `${window.location.pathname}?${params.toString()}` : window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, [searchParams]);

  return (
    <Dialog.Root size={"md"} placement={"center"} open={open} onOpenChange={(e) => setOpen(e.open)}>
      <Dialog.Trigger asChild>
        <Button
          variant="ghost"
          colorPalette="gray"
          width="100%"
          justifyContent="flex-start"
          textAlign="left"
          size="sm"
          py={0}
        >
          <RiChatSettingsFill />
          Notification Settings
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxHeight="80vh" overflowY="auto">
            <Dialog.Header>
              <Dialog.Title>Notification Settings</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <NotificationPreferences initialDiscussionNotification={initialDiscussionNotification} />
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Close</Button>
              </Dialog.ActionTrigger>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

const TimeZonePreferencesMenu = () => {
  const { courseTimeZone } = useTimeZone();
  const browserTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  try {
    // Only show if timezones differ
    if (courseTimeZone === browserTimeZone) {
      return null;
    }

    return (
      <Dialog.Root size="md" placement="center">
        <Dialog.Trigger asChild>
          <Button
            variant="ghost"
            colorPalette="gray"
            width="100%"
            justifyContent="flex-start"
            textAlign="left"
            size="sm"
            py={0}
          >
            <FiClock size={16} />
            Time Zone Settings
          </Button>
        </Dialog.Trigger>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Time Zone Settings</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <TimeZoneSelector />
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Close</Button>
                </Dialog.ActionTrigger>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  } catch (error) {
    console.error("TimeZonePreferencesMenu error:", error);
    // TimeZone provider not available, don't render
    return null;
  }
};

function UserSettingsMenu() {
  const [open, setOpen] = useState(false);
  const searchParams = useSearchParams();
  const { role: enrollment } = useClassProfiles();
  const gitHubUsername = enrollment.users.github_username;
  const { private_profile_id } = useClassProfiles();
  const { data: privateProfile } = useOne<UserProfile>({
    resource: "profiles",
    id: private_profile_id
  });

  // Open drawer if URL parameters indicate notification settings should be opened
  useEffect(() => {
    if (searchParams.get("openNotificationSettings") === "true" || searchParams.get("setDiscussionNotification")) {
      setOpen(true);
    }
  }, [searchParams]);

  return (
    <Drawer.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
      <Drawer.Trigger>
        <Avatar.Root size="sm" colorPalette="gray">
          <Avatar.Fallback name={privateProfile?.data.name?.charAt(0) ?? "?"} />
          <Avatar.Image src={privateProfile?.data.avatar_url ?? undefined} />
        </Avatar.Root>
      </Drawer.Trigger>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content pt={2} pl={2} borderTopLeftRadius="md" borderWidth={1} borderColor="border.emphasized">
            <Drawer.Body p={2}>
              <VStack alignItems="flex-start" gap={0}>
                <HStack justifyContent="space-between" alignItems="flex-start" width="100%" pb={2}>
                  <HStack flex={1} minWidth={0}>
                    <Avatar.Root size="sm" colorPalette="gray">
                      <Avatar.Fallback name={privateProfile?.data.name?.charAt(0) ?? "?"} />
                      <Avatar.Image src={privateProfile?.data.avatar_url ?? undefined} />
                    </Avatar.Root>
                    <VStack alignItems="flex-start" gap={0} flex={1} minWidth={0}>
                      <Text fontWeight="bold" wordBreak="break-word" lineHeight="1.2">
                        {privateProfile?.data.name}
                      </Text>
                      {gitHubUsername && (
                        <Text fontSize="sm">
                          GitHub:{" "}
                          <Link href={`https://github.com/${gitHubUsername}`} target="_blank">
                            {gitHubUsername}
                          </Link>
                        </Text>
                      )}
                    </VStack>
                  </HStack>
                  <Drawer.CloseTrigger asChild>
                    <CloseButton size="sm" aria-label="Close" />
                  </Drawer.CloseTrigger>
                </HStack>
                <ProfileChangesMenu />
                <NotificationPreferencesMenu />
                <TimeZonePreferencesMenu />

                <Button
                  variant="ghost"
                  onClick={signOutAction}
                  width="100%"
                  textAlign="left"
                  size="sm"
                  justifyContent="flex-start"
                >
                  <PiSignOut />
                  Sign out
                </Button>
              </VStack>
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
function ObfuscatedGradesModePicker() {
  const isObfuscated = useObfuscatedGradesMode();
  const setIsObfuscated = useSetObfuscatedGradesMode();
  return (
    <Tooltip content={isObfuscated ? "Show all grades" : "Obfuscate grades in UI"} showArrow>
      <IconButton
        variant="outline"
        size="sm"
        onClick={() => setIsObfuscated(!isObfuscated)}
        aria-label="Toggle obfuscated grades mode"
        css={{ _icon: { width: "5", height: "5" } }}
      >
        {isObfuscated ? <TbSpyOff /> : <TbSpy />}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Shows realtime connection status for both class and office hours functionality.
 * Automatically detects office hours context and includes relevant channels.
 */
function ConnectionStatusIndicator() {
  const status = useAutomaticRealtimeConnectionStatus();

  if (!status) {
    return null;
  }

  const getStatusColor = () => {
    switch (status.overall) {
      case "connected":
        return "green.emphasized";
      case "partial":
        return "orange.emphasized";
      case "disconnected":
        return "red.solid";
      case "connecting":
        return "yellow.solid";
      default:
        return "gray.muted";
    }
  };

  const getStatusText = () => {
    switch (status.overall) {
      case "connected":
        return "All realtime connections active";
      case "partial":
        return "Some realtime connections failed";
      case "disconnected":
        return "No realtime connections active";
      case "connecting":
        return "Connecting to realtime channels...";
      default:
        return "Unknown status";
    }
  };

  const getChannelTypeName = (type: string) => {
    switch (type) {
      case "staff":
        return "Staff data";
      case "user":
        return "Your class data";
      case "submission_graders":
        return "Staff submission data for this submission";
      case "submission_user":
        return "Your submission data for this submission";
      case "help_queues":
        return "Office hours queues";
      case "help_request":
        return "Help request data";
      case "help_request_staff":
        return "Help request staff data";
      case "help_queue":
        return "Help queue data";
      default:
        return type;
    }
  };

  const getChannelDetails = (channel: (typeof status.channels)[0]) => {
    const details = [];

    if (channel.submissionId) {
      details.push(`submission ${channel.submissionId}`);
    }

    if (channel.help_request_id) {
      details.push(`request ${channel.help_request_id}`);
    }

    if (channel.help_queue_id) {
      details.push(`queue ${channel.help_queue_id}`);
    }

    return details.length > 0 ? ` (${details.join(", ")})` : "";
  };

  const tooltipContent = (
    <VStack alignItems="flex-start" gap={1} fontSize="sm">
      <Text fontWeight="bold">{getStatusText()}</Text>
      <Text fontSize="xs" color="gray.300">
        {status.channels.length} channel{status.channels.length !== 1 ? "s" : ""}
      </Text>
      {status.channels.map((channel, index) => (
        <HStack key={index} fontSize="xs" gap={2}>
          <Box width={2} height={2} borderRadius="full" bg={channel.state === "joined" ? "green.400" : "red.400"} />
          <Text>
            {getChannelTypeName(channel.type)}
            {getChannelDetails(channel)}
          </Text>
          <Text color="gray.400">({channel.state})</Text>
        </HStack>
      ))}
    </VStack>
  );

  return (
    <Tooltip content={tooltipContent} showArrow>
      <Box
        width={3}
        height={3}
        borderRadius="full"
        bg={getStatusColor()}
        aria-label={`Realtime connection status: ${getStatusText()}`}
        role="note"
        cursor="help"
        flexShrink={0}
      />
    </Tooltip>
  );
}

function TimeZoneIndicator() {
  const { mode, timeZone, courseTimeZone, browserTimeZone, openModal } = useTimeZone();

  // Only show indicator if timezones differ
  if (courseTimeZone === browserTimeZone) {
    return null;
  }

  const getTimeZoneAbbr = (tz: string) => {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en", {
        timeZone: tz,
        timeZoneName: "short"
      });
      const parts = formatter.formatToParts(now);
      return parts.find((part) => part.type === "timeZoneName")?.value || tz;
    } catch {
      return tz;
    }
  };

  return (
    <Button
      variant="outline"
      colorPalette={mode === "course" ? "red" : "green"}
      size="xs"
      fontSize="xs"
      onClick={openModal}
    >
      <HStack gap={1}>
        <FiClock size={12} />
        <Text>
          {mode === "course" ? "course" : "local"} time ({getTimeZoneAbbr(timeZone)})
        </Text>
      </HStack>
    </Button>
  );
}

export default function UserMenu() {
  return (
    <HStack minWidth={0}>
      <TimeZoneIndicator />
      <ConnectionStatusIndicator />
      <SupportMenu />
      <ColorModeButton colorPalette="gray" variant="outline" />
      <NotificationsBox />
      <ObfuscatedGradesModePicker />
      <UserSettingsMenu />
    </HStack>
  );
}
