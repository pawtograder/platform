'use client'

import { SkeletonCircle } from "@/components/ui/skeleton";
import { Button, CloseButton, Dialog, Drawer, Flex, HStack, Icon, IconButton, Menu, Portal, Text, VStack } from "@chakra-ui/react";
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



function SupportMenu() {
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
    const [avatarLink, setAvatarLink] = useState<string | undefined | null>(null);

    const completeAvatarUpload = async (file: File) => {
        console.log(file);
        console.log("attempting avatar upload");
        const uuid = crypto.randomUUID();
        const fileName = file.name.replace(/[^a-zA-Z0-9-_\.]/g, '_');

        /*
        Avatar link should be uploaded to storage here, discard if it doesn't get used.  Or, potentially tweak Avatar display to show image file,
        and only upload to storage if user submits changes (depends on how we implement for instructors making changes).

        const {data, error} = await supabase.storage.from('uploads').upload(`${course_id}/profiles/${uuid}/${fileName}`, file, { upsert: true });
        
        if(!data || error) {
            console.log("Error uploading avatar image");
        }
        else {
            console.log(data);
            setAvatarLink(data.path);
        }
        */
    }

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (!acceptedFiles || acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];

    // Ensure the file is a PDF
    if (file.type === 'image/jpeg' || file.type === 'image/png') {
      completeAvatarUpload(file);
    } else {
      alert('Please upload a valid PDF file.');
    }
  }, [completeAvatarUpload],)


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
                                <Dialog.Root size={"md"} placement={"center"}>
                                    <Dialog.Trigger asChild>
                                    <Button>
                                        Open
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
                                            <Flex alignItems="center" justifyContent={"center"}>
                                                <div {...getRootProps()}>
                                                <input {...getInputProps()}/>
                                                <Avatar width="100px" height="100px" src={avatarLink || undefined} size="sm" 
                                                _hover={{
                                                            boxShadow: "0px 4px 4px rgba(0, 0, 0, 0.25)",
                                                            background: "rgba(0, 0, 0, 0.5)",
                                                            opacity: 0.4,
                                                }}
                                                />

                                                </div>
                                               
                                            </Flex>
                                        </Dialog.Body>
                                        <Dialog.Footer>
                                            <Dialog.ActionTrigger asChild>
                                            <Button variant="outline">Cancel</Button>
                                            </Dialog.ActionTrigger>
                                            <Button>Save</Button>
                                        </Dialog.Footer>
                                        </Dialog.Content>
                                    </Dialog.Positioner>
                                    </Portal>
                                </Dialog.Root>
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