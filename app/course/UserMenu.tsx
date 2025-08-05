"use client";

import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Drawer,
  Flex,
  HStack,
  Icon,
  IconButton,
  Menu,
  Portal,
  Text,
  VStack
} from "@chakra-ui/react";
import { FaCircleUser } from "react-icons/fa6";
import { PiSignOut } from "react-icons/pi";
import { signOutAction } from "../actions";

import { useInvalidate, useList, useOne } from "@refinedev/core";

import { ColorModeButton } from "@/components/ui/color-mode";
import Link from "@/components/ui/link";
import NotificationsBox from "@/components/ui/notifications/notifications-box";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import useAuthState, { useCourse } from "@/hooks/useAuthState";
import { useObfuscatedGradesMode, useSetObfuscatedGradesMode } from "@/hooks/useCourseController";
import { useRealtimeConnectionStatus } from "@/hooks/useRealtimeConnectionStatus";
import { createClient } from "@/utils/supabase/client";
import type { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Avatar } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { FaGithub, FaUnlink } from "react-icons/fa";
import { HiOutlineSupport } from "react-icons/hi";
import { TbSpy, TbSpyOff } from "react-icons/tb";

function SupportMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Tooltip content="Support & Documentation" showArrow>
          <IconButton variant="outline" colorPalette="gray" size="sm">
            <HiOutlineSupport />
          </IconButton>
        </Tooltip>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
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
              <Link
                href={"https://github.com/pawtograder/platform/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug"}
                target="_blank"
              >
                View open bugs
              </Link>
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
  const supabase = createClient();
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
          `${process.env["NEXT_PUBLIC_SUPABASE_URL"]}/storage/v1/object/public/avatars/${user?.id}/${course_id}/${uuid}.${fileExtension}`
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
      if (!file) {
        return;
      }
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
                  onClick={() => setAvatarLink(`https://api.dicebear.com/9.x/identicon/svg?seed=${profile?.name}`)}
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
  const supabase = createClient();
  const { course_id } = useParams();
  const { user } = useAuthState();
  const invalidate = useInvalidate();
  const { private_profile_id, public_profile_id } = useCourse();

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
    }
  }, [publicProfile, privateProfile]);

  /**
   * Updates user profile on "Save" by replacing avatar_url in database with new file.  Removes extra files in user's avatar
   * storage bucket.
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
          <Button variant="ghost" colorPalette={"gray"} w="100%" justifyContent="flex-start" size="sm" py={0}>
            <Icon as={FaCircleUser} size="md" />
            Edit Avatar
          </Button>
        </Dialog.Trigger>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Edit Avatar</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Flex flexDirection={"column"} gap="50px">
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
                  <Text fontSize="sm" color="fg.muted">
                    Your public avatar will be used on anonymous posts along with your pseudonym, &quot;
                    {publicProfile?.data.name}&quot;.
                  </Text>
                </Flex>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPrivateAvatarLink(privateProfile?.data.avatar_url ?? null);
                      setPublicAvatarLink(publicProfile?.data.avatar_url ?? null);
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

function UserSettingsMenu() {
  const [open, setOpen] = useState(false);
  const supabase = createClient();
  const { user } = useAuthState();
  const [gitHubUsername, setGitHubUsername] = useState<string | null>(null);
  const { private_profile_id } = useCourse();
  const { data: privateProfile } = useOne<UserProfile>({
    resource: "profiles",
    id: private_profile_id
  });
  const uid = user?.id;
  const { data: dbUser } = useList<{ user_id: string; github_username: string }>({
    resource: "users",
    meta: {
      select: "user_id, github_username"
    },
    filters: [
      {
        field: "user_id",
        operator: "eq",
        value: uid
      }
    ],
    queryOptions: {
      enabled: uid !== undefined
    }
  });

  useEffect(() => {
    if (dbUser && dbUser.data.length > 0) {
      setGitHubUsername(dbUser.data[0]?.github_username ?? null);
    }
  }, [dbUser]);

  const unlinkGitHub = useCallback(async () => {
    const identities = await supabase.auth.getUserIdentities();
    const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");
    if (!githubIdentity) {
      throw new Error("GitHub identity not found");
    }
    const { error } = await supabase.auth.unlinkIdentity(githubIdentity);
    if (error) {
      throw new Error(error.message);
    }
    setGitHubUsername(null);
  }, [supabase]);
  const linkGitHub = useCallback(async () => {
    const { error } = await supabase.auth.linkIdentity({
      provider: "github",
      options: { redirectTo: `${window.location.href}` }
    });
    if (error) {
      throw new Error(error.message);
    }
  }, [supabase]);

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
                    <CloseButton size="sm" />
                  </Drawer.CloseTrigger>
                </HStack>

                {!gitHubUsername && (
                  <Button
                    onClick={linkGitHub}
                    colorPalette="gray"
                    w="100%"
                    variant="ghost"
                    size="sm"
                    justifyContent="flex-start"
                    py={0}
                  >
                    <Icon as={FaGithub} size="md" />
                    Link GitHub
                  </Button>
                )}
                {gitHubUsername && (
                  <>
                    <PopConfirm
                      triggerLabel="Unlink GitHub"
                      trigger={
                        <Button
                          variant="ghost"
                          colorPalette="red"
                          size="sm"
                          w="100%"
                          disabled={true}
                          alignItems="center"
                          gap={2}
                          justifyContent="flex-start"
                          py={0}
                        >
                          <Icon as={FaUnlink} size="md" />
                          Unlink GitHub
                        </Button>
                      }
                      confirmHeader="Unlink GitHub"
                      confirmText="Are you sure you want to unlink your GitHub account? You should only do this if you have linked the wrong account. You will need to re-link your GitHub account to use Pawtograder."
                      onConfirm={() => {
                        unlinkGitHub();
                      }}
                      onCancel={() => {}}
                    ></PopConfirm>
                  </>
                )}
                <ProfileChangesMenu />
                <Button
                  variant="ghost"
                  pl={0}
                  onClick={signOutAction}
                  width="100%"
                  textAlign="left"
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
        <Icon as={isObfuscated ? TbSpyOff : TbSpy} />
      </IconButton>
    </Tooltip>
  );
}

function ConnectionStatusIndicator() {
  const status = useRealtimeConnectionStatus();

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
      default:
        return type;
    }
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
            {channel.submissionId ? ` (${channel.submissionId})` : ""}
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
export default function UserMenu() {
  return (
    <HStack minWidth={0}>
      <ConnectionStatusIndicator />
      <SupportMenu />
      <ColorModeButton colorPalette="gray" variant="outline" />
      <NotificationsBox />
      <ObfuscatedGradesModePicker />
      <UserSettingsMenu />
    </HStack>
  );
}
