'use client'

import { SkeletonCircle } from "@/components/ui/skeleton";
import { Box, Button, CloseButton, Dialog, Drawer, Flex, HStack, Icon, IconButton, Menu, Portal, Text, VStack } from "@chakra-ui/react";
import { PiSignOut } from "react-icons/pi";
import { signOutAction } from "../actions";

import { Avatar } from "@/components/ui/avatar";
import { ColorModeButton } from "@/components/ui/color-mode";
import NotificationsBox from "@/components/ui/notifications/notifications-box";
import { PopConfirm } from "@/components/ui/popconfirm";
import useAuthState from "@/hooks/useAuthState";
import { createClient } from "@/utils/supabase/client";
import { UserProfile } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FaGithub, FaUnlink, FaQuestionCircle } from "react-icons/fa";
import Link from "@/components/ui/link";
import { HiOutlineSupport } from "react-icons/hi";
import { useDropzone } from 'react-dropzone';
import { setDefaultAutoSelectFamily } from "net";
import { imageOptimizer } from "next/dist/server/image-optimizer";



function SupportMenu()  {
    return <Menu.Root>
        <Menu.Trigger asChild>
            <IconButton variant="outline" colorPalette="gray" size="sm">
                <HiOutlineSupport />
            </IconButton>
        </Menu.Trigger>
        <Portal>
            <Menu.Positioner>
                <Menu.Content>
                    <Menu.Item value="view-docs">
                        <Link href={'https://docs.pawtograder.com'} target="_blank">
                            View documentation
                        </Link>
                    </Menu.Item>
                    <Menu.Item value="report-feature-request">
                        <Link href={'https://github.com/pawtograder/platform/issues/new?labels=enhancement&template=feature_request.md'} target="_blank">
                            Request a feature
                        </Link>
                    </Menu.Item>
                    <Menu.Item value="report-bug">
                        <Link href={'https://github.com/pawtograder/platform/issues/new?labels=bug&template=bug_report.md'} target="_blank">
                            Report a bug
                        </Link>
                    </Menu.Item>
                    <Menu.Item value="view-open-bugs">
                        <Link href={'https://github.com/pawtograder/platform/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug'} target="_blank">
                            View open bugs
                        </Link>
                    </Menu.Item>

                </Menu.Content>
            </Menu.Positioner>
        </Portal>
    </Menu.Root>
}

/**
 * Modal that handles user profile updates, currently only avatar changes.
 */
const ProfileChangesMenu = ({
    profile
} : {
    profile:UserProfile|null
}) =>{
    const [avatarLink, setAvatarLink] = useState<string | undefined | null>(null);
    const [isHovered, setIsHovered] = useState<boolean>(false);
    const supabase = createClient();
    const { course_id } = useParams();

    /**
     * Uploads user image to avatar storage bucket under avatars/[userid]/[courseid]/uuid.extension 
     * @param file jpg or png image file for new avatar
     */
    const completeAvatarUpload = async (file: File) => {
        if(!profile) {
            console.log("Profile required to complete avatar upload");
            return;
        }
        const uuid = crypto.randomUUID();
        const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, '_');
        const fileExtension = fileName.split('.').pop();
        const { data, error } = await supabase.storage.from('avatars').upload(`${profile.id}/${course_id}/${uuid}.${fileExtension}`, file);

        if(!data || error) {
            console.log("Error uploading avatar image with error " + error);
        }
        else {
            setAvatarLink(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/avatars/${profile.id}/${course_id}/${uuid}.${fileExtension}`);
        }
    }

    /**
     * Handles user file drops to accept only the first png or img file chosen.  Prompts file to be uploaded to storage.
     */
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    if (file.type === 'image/jpeg' || file.type === 'image/png') {
      completeAvatarUpload(file);
    } else {
      alert('Please upload a valid PDF file.');
    }
  }, [completeAvatarUpload],)

  /**
   * Updates user profile on "Save" by replacing avatar_url in database with new file.  Removes extra files in user's avatar 
   * storage bucket.
   */
  const updateProfile = async () => {
    if(!avatarLink || !profile?.id) {
        return;
    }
    /**
     * TO DO:
     * - Ensure correct accessibility for avatar images.  Users should be able to view and update these images. Everyone should be able to view 
     * these images
     * - Ensure RLS is configured correctly s/t users can update only their avatar_url
     * - After the user saves their avatar, excess files should be removed from storage 
     * - Clarify the relationship between public and private profile photos
     * 
     * Nice to have: users should be able to rearrange / preview what their photos will look like inside the circle 
     */
    //removeUnusedImages();
    const {data, error} = await supabase.from('profiles').update({avatar_url:avatarLink}).eq("id", profile?.id).single();
    if(!data || error) {
        console.log("Error updating user profile");
    }
  }

  /**
   * Removes extra images from storage that may have been populated if the user attempted to open the menu and reselect multiple times.
   */
  const removeUnusedImages = async () => {
    if(!avatarLink || !profile?.id) {
        return;
    }
    // determine from the database 
    const {data, error} = await supabase.storage.from('avatars').list(`${profile.id}/${course_id}`);
    if(!data || error) {
        console.log("failed to find profile photo to update");
        return;
    }
    // transform data to a list of file paths that should be removed from avatars
    const pathsToRemove = data.filter((image) => (!avatarLink.includes(image.id))).map((imageToRemove) => `${profile.id}/${course_id}/${imageToRemove}.${ imageToRemove.name.split('.').pop()}`);
    const {data:removeData, error:removeError} = await supabase.storage.from('avatars').remove(pathsToRemove);
    if(error) {
        console.log("Error removing extra files: " + error);
    }
  }

    const {    
        acceptedFiles,
        fileRejections,
        getRootProps,
        getInputProps
     } = useDropzone({
        onDrop,
    accept: {
        'image/jpeg': [],
        'image/png': []
      }
  });

  // when profile is changed, change current avatar to match
  useEffect(() => {
    if(!profile) {
        return;
    }
    setAvatarLink(profile.avatar_url);
  }, [profile]);


    return <Dialog.Root size={"md"} placement={"center"}>
    <Dialog.Trigger asChild>
    <Button>
        Edit Profile
    </Button>
    </Dialog.Trigger>
    <Portal>
    <Dialog.Backdrop />
    <Dialog.Positioner >
        <Dialog.Content>
        <Dialog.Header>
            <Dialog.Title>{profile?.name}</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
            <Flex alignItems="center" justifyContent={"center"} {...getRootProps()}>
            <Box position="relative" width="100px" height="100px" >
                <input {...getInputProps()}/>
                <Avatar position="absolute" width="100%" height="100%" src={avatarLink || undefined} size="sm" 
                _hover={
                    {
                            boxShadow: "0px 4px 4px rgba(0, 0, 0, 0.25)",
                            background: "rgba(0, 0, 0, 0.5)",
                            opacity: 0.2,
                            zIndex:10
                }}
                
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                />
                {isHovered && <Flex
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
                        zIndex:20
                    }}
                    >
                    <Text>Edit Avatar</Text>
            </Flex>}
            </Box>
            </Flex>
        </Dialog.Body>
        <Dialog.Footer>
            <Dialog.ActionTrigger asChild>
            <Button variant="outline">Cancel</Button>
            </Dialog.ActionTrigger>
            <Dialog.ActionTrigger asChild>
                <Button onClick={updateProfile}>Save</Button>
            </Dialog.ActionTrigger>
        </Dialog.Footer>
        </Dialog.Content>
    </Dialog.Positioner>
    </Portal>
</Dialog.Root>
}


function UserSettingsMenu() {
    const [open, setOpen] = useState(false)
    const supabase = createClient();
    const { user } = useAuthState();
    const { course_id } = useParams();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [gitHubUsername, setGitHubUsername] = useState<string | null>(null);
    useEffect(() => {
        // Fetch profile
        const fetchProfile = async () => {
            if (course_id) {
                const { data, error } = await supabase.from('user_roles').select('profiles!private_profile_id(*), users(*)').
                    eq('user_id', user!.id).eq('class_id', Number(course_id)).single();
                if (error) {
                    console.error(error)
                }
                if (data) {
                    setProfile(data.profiles!)
                    if (data.users) {
                        setGitHubUsername(data.users.github_username);
                    }
                }
            } else {
                const { data, error } = await supabase.from('user_roles').select('profiles!private_profile_id(*), users(*)').
                    eq('user_id', user!.id).limit(1).single();
                if (error) {
                    console.error(error)
                }
                if (data) {
                    setProfile(data.profiles!)
                    if (data.users) {
                        setGitHubUsername(data.users.github_username);
                    }
                }
            }
        };
        fetchProfile()
    }, [course_id, user])

    const unlinkGitHub = useCallback(async () => {
        const identities = await supabase.auth.getUserIdentities()
        const githubIdentity = identities.data?.identities.find(
            identity => identity.provider === 'github'
        )
        if (!githubIdentity) {
            throw new Error("GitHub identity not found")
        }
        const { error } = await supabase.auth.unlinkIdentity(githubIdentity)
        if (error) {
            throw new Error(error.message)
        }
        setGitHubUsername(null);
    }, [supabase])
    const linkGitHub = useCallback(async () => {
        const { data, error } = await supabase.auth.linkIdentity({
            provider: 'github', options: {
                redirectTo: `${window.location.href}`
            }
        })
        if (error) {
            throw new Error(error.message)
        }
    }, [supabase])
    

    return (
        <Drawer.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
            <Drawer.Trigger>
                {profile && profile.avatar_url ? <Avatar
                    size={'sm'}
                    src={
                        profile.avatar_url
                    }
                /> : <SkeletonCircle size="8" />}
            </Drawer.Trigger>
            <Portal>
                <Drawer.Backdrop />
                <Drawer.Positioner>

                    <Drawer.Content pt={2} pl={2} borderTopLeftRadius="md" borderWidth={1} borderColor="border.emphasized">
                        <Drawer.CloseTrigger asChild>
                            <CloseButton size="sm" position="absolute" right={4} top={4} />
                        </Drawer.CloseTrigger>
                        <Drawer.Body p={2}>
                            <VStack alignItems="flex-start">
                                <HStack>
                                    <Avatar src={profile?.avatar_url || undefined} size="sm"/>
                                    <VStack alignItems="flex-start">
                                        <Text fontWeight="bold">{profile?.name}</Text>
                                    </VStack>
                                </HStack>
                                <HStack>
                                    <Icon as={FaGithub} />
                                    {!gitHubUsername && <Button onClick={linkGitHub} colorPalette="teal">Link GitHub</Button>}
                                    {gitHubUsername && <><Text fontSize="sm">Linked to {gitHubUsername}</Text>                                    <PopConfirm
                                        triggerLabel="Unlink GitHub"
                                        trigger={<Button variant="ghost" colorPalette="red" size="sm" p={0}><Icon as={FaUnlink} /></Button>}
                                        confirmHeader="Unlink GitHub"
                                        confirmText="Are you sure you want to unlink your GitHub account? You should only do this if you have linked the wrong account. You will need to re-link your GitHub account to use Pawtograder."
                                        onConfirm={() => {
                                            unlinkGitHub()
                                        }}
                                        onCancel={() => {
                                        }}

                                    ></PopConfirm>
                                    </>
                                    }
                                </HStack>
                                <ProfileChangesMenu profile={profile}/>
                                
                               <Button variant="ghost"
                                    pl={0}
                                    onClick={signOutAction}
                                    width="100%" textAlign="left" justifyContent="flex-start">
                                    <PiSignOut />
                                    Sign out
                                </Button>
                            </VStack>
                        </Drawer.Body>

                    </Drawer.Content>
                </Drawer.Positioner>
            </Portal>
        </Drawer.Root>
    )
}
export default function UserMenu() {

    const { course_id } = useParams();

    return (
        <HStack>
            <SupportMenu />
            <ColorModeButton colorPalette="gray" variant="outline" />
            <NotificationsBox />
            <UserSettingsMenu />
        </HStack>

    );
}