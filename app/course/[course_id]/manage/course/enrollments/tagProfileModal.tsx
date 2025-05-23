import { Button, Dialog, Field, Fieldset, Flex, Input, SegmentGroup, Text } from "@chakra-ui/react";
import { useState } from "react";
import { SingleValue, Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { TagColor } from "./TagColors";
import { FaTag } from "react-icons/fa6";
import useTags from "@/hooks/useTags";
import TagDisplay from "@/components/ui/tag";
import { Tag, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useDelete, useInvalidate } from "@refinedev/core";
import { toaster } from "@/components/ui/toaster";

export default function TagProfileModal({
  profiles,
  bulk,
  clearProfiles,
  commonTag
}: {
  profiles: UserRoleWithPrivateProfileAndUser[];
  bulk: boolean;
  clearProfiles: () => void;
  commonTag?: Tag;
}) {
  const [title, setTitle] = useState<string>("");
  const [visible, setVisible] = useState<SingleValue<{ label: string; value: boolean }>>();
  const [color, setColor] = useState<SingleValue<{ label: string; value: string }>>();
  const [strategy, setStrategy] = useState<"create_new" | "use_old" | "remove_tag">("create_new");
  const [selectedTag, setSelectedTag] = useState<SingleValue<{ label: string; value: Tag }>>();
  const tags = useTags();
  const { course_id } = useParams();
  const { mutate } = useCreate();
  const { mutate: deleteMutation } = useDelete();

  const invalidate = useInvalidate();

  const tagUser = async () => {
    if (strategy === "create_new") {
      // default color red, default visibility private to instructor
      profiles.forEach(async (profile) => {
        await createNewTag(
          title,
          color ? color.value : TagColor.RED.toString(),
          visible ? visible.value : false,
          profile
        );
      });
    } else if (strategy === "use_old") {
      if (!selectedTag) {
        toaster.error({
          title: "Failed to tag user",
          description: "Cannot tag user based on previous tag because no tag is selected."
        });
        return;
      }
      profiles.forEach(async (profile) => {
        await createNewTag(selectedTag.value.name, selectedTag.value.color, selectedTag.value.visible, profile);
      });
    } else if (strategy === "remove_tag" && bulk && commonTag) {
      profiles.forEach(async (profile) => {
        await removeTag(profile, commonTag.id);
      });
    } else if (strategy === "remove_tag" && !bulk && selectedTag) {
      profiles.forEach(async (profile) => {
        await removeTag(profile, selectedTag.value.id);
      });
    }
    // clear as modal is closed and action is complete
    clearProfiles();
  };

  const removeTag = async (profile: UserRoleWithPrivateProfileAndUser, tag_id: string) => {
    deleteMutation(
      {
        resource: "tags",
        id: tag_id
      },
      {
        onSuccess: () => {
          toaster.success({
            title: "Successfully deleted tag",
            description: "Removed tag " + name + " from " + profile.profiles.name
          });
          invalidate({
            resource: "tags",
            invalidates: ["list"] // To refresh the table
          });
        },
        onError: (error) => {
          toaster.error({
            title: "Error removing tag",
            type: "Found error " + error + " for " + profile.profiles.name
          });
        }
      }
    );
  };

  const createNewTag = async (
    name: string,
    color: string,
    visible: boolean,
    profile: UserRoleWithPrivateProfileAndUser
  ) => {
    const idToUse = name.charAt(0) === "~" ? profile.private_profile_id : profile.public_profile_id;

    if (
      tags.tags.find((tag) => {
        return (
          tag.profile_id === idToUse &&
          (tag.name === name) !== undefined &&
          tag.color === color &&
          tag.visible === tag.visible
        );
      })
    ) {
      toaster.create({
        title: "Tag was not added",
        description: 'You cannot add "' + name + '" to ' + profile.profiles.name + " because they alredy have that tag"
      });
      return;
    }
    mutate(
      {
        resource: "tags",
        values: {
          id: crypto.randomUUID(),
          name: name,
          color: color,
          visible: visible,
          profile_id: idToUse,
          class_id: course_id
        }
      },
      {
        onSuccess: () => {
          toaster.success({
            title: "Tag created",
            description: "Successfully tagged " + profile.profiles.name + " with " + name
          });
          invalidate({
            resource: "tags",
            invalidates: ["list"] // To refresh the table
          });
        },
        onError: (error) => {
          toaster.error({
            title: "Error tagging user",
            type: "Found error " + error + " for " + profile.profiles.name
          });
        }
      }
    );
  };

  return (
    <Dialog.Root
      placement={"center"}
      onExitComplete={() => {
        setTitle("");
        setSelectedTag(undefined);
        setVisible(null);
        setColor(null);
        setStrategy("create_new");
      }}
    >
      <Dialog.Trigger as="div">
        {!bulk ? (
          <FaTag />
        ) : (
          <Button disabled={profiles.length === 0}>
            Edit tags for {profiles.length} selected user{profiles.length !== 1 ? "s" : ""}
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{bulk ? "Tag profiles" : "Tag profile"}</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Fieldset.Root>
              <Field.Root>
                <Field.Label>Profile{profiles.length !== 1 ? "s" : ""} to configure</Field.Label>
                <Flex flexDirection={"column"}>
                  {profiles?.map((prof, key) => <Text key={key}>{prof.profiles.name}</Text>)}
                </Flex>
              </Field.Root>
              <Field.Root>
                <SegmentGroup.Root
                  value={strategy}
                  onValueChange={(details) => {
                    setStrategy(details.value as "create_new" | "use_old");
                  }}
                >
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Item value="create_new">
                    <SegmentGroup.ItemText>Create new tag</SegmentGroup.ItemText>
                    <SegmentGroup.ItemHiddenInput />
                  </SegmentGroup.Item>
                  <SegmentGroup.Item value="use_old">
                    <SegmentGroup.ItemText>Add existing tag</SegmentGroup.ItemText>
                    <SegmentGroup.ItemHiddenInput />
                  </SegmentGroup.Item>
                  {(!bulk || commonTag) && (
                    <SegmentGroup.Item value="remove_tag">
                      <SegmentGroup.ItemText>Remove {bulk ? "shared" : ""} tag</SegmentGroup.ItemText>
                      <SegmentGroup.ItemHiddenInput />
                    </SegmentGroup.Item>
                  )}
                </SegmentGroup.Root>
              </Field.Root>

              {strategy === "create_new" && (
                <>
                  <Field.Root>
                    <Field.Label>Tag name</Field.Label>
                    <Input
                      onChange={(e) => {
                        setTitle(e.target.value);
                      }}
                    />
                    <Field.HelperText>
                      To assign the tag to private profiles, prefix the name with &apos;~&apos;
                    </Field.HelperText>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Tag visible to profile owner?</Field.Label>
                    <Select
                      onChange={(e) => setVisible(e)}
                      isMulti={false}
                      options={[
                        { label: "Yes", value: true },
                        { label: "No", value: false }
                      ]}
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Tag color</Field.Label>
                    <Select
                      onChange={(e) => setColor(e)}
                      isMulti={false}
                      options={TagColor.colors().map((color) => {
                        return { label: color.toString(), value: color.toString() };
                      })}
                    />
                  </Field.Root>
                </>
              )}
              {strategy === "use_old" && (
                <>
                  <Field.Root>
                    <Field.Label>Choose tag</Field.Label>
                    <Select
                      isMulti={false}
                      onChange={(e) => {
                        setSelectedTag(e);
                      }}
                      options={Array.from(
                        tags.tags
                          .reduce((map, p) => {
                            if (!map.has(p.name)) {
                              map.set(p.name, p);
                            }
                            return map;
                          }, new Map())
                          .values()
                      ).map((p) => ({ label: p.name, value: p }))}
                    />
                    <Field.HelperText>
                      Tags prefixed with &apos;~&apos; will be assigned to the user&apos;s private profile. All others
                      will be assigned to public profiles.
                    </Field.HelperText>
                  </Field.Root>
                  {selectedTag && (
                    <>
                      <Field.Root>
                        <Field.Label>Visiblity</Field.Label>
                        <Text>{selectedTag?.value.visible ? "Visible" : "Not visible"}</Text>
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>Color</Field.Label>
                        <TagDisplay
                          name={
                            TagColor.colors()
                              .find((c) => {
                                return c.toString() == selectedTag?.value.color;
                              })
                              ?.toString() ?? ""
                          }
                          color={selectedTag?.value.color}
                        />
                      </Field.Root>
                    </>
                  )}
                </>
              )}
              {strategy === "remove_tag" && !bulk && (
                <>
                  <Field.Root>
                    <Field.Label>Choose tag to remove</Field.Label>
                    <Select
                      isMulti={false}
                      onChange={(e) => {
                        setSelectedTag(e);
                      }}
                      options={tags.tags
                        .filter(
                          (tag) =>
                            tag.profile_id === profiles[0].public_profile_id ||
                            tag.profile_id === profiles[0].private_profile_id
                        )
                        .map((p) => ({ label: p.name, value: p }))}
                    />
                  </Field.Root>
                </>
              )}
              {strategy === "remove_tag" &&
                bulk &&
                (commonTag ? (
                  <>
                    <Field.Root>
                      <Field.Label>Common tag to remove (taken from table filter)</Field.Label>
                      <TagDisplay name={commonTag.name} color={commonTag.color}></TagDisplay>
                      <Field.HelperText>Press save to remove this tag from the listed profiles</Field.HelperText>
                    </Field.Root>
                  </>
                ) : (
                  <Text>No common tag found. Please choose another option or perform this operation individually.</Text>
                ))}
            </Fieldset.Root>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.CloseTrigger as="div">
              <Button colorPalette="red">Cancel</Button>
            </Dialog.CloseTrigger>
            <Dialog.CloseTrigger as="div">
              <Button
                colorPalette="green"
                disabled={
                  !(
                    // for remove of individual or use existing tag for any
                    (
                      selectedTag ||
                      // for create new tag for any
                      (title && color && visible) ||
                      // for remove for bulk
                      (bulk && commonTag && strategy == "remove_tag")
                    )
                  )
                }
                onClick={() => {
                  tagUser();
                }}
              >
                Save
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
