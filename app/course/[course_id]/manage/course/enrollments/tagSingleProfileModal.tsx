import { Button, Dialog, Field, Fieldset, Input, SegmentGroup, Text } from "@chakra-ui/react";
import { useState } from "react";
import { SingleValue, Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { TagColor } from "./TagColors";
import { FaTag } from "react-icons/fa6";
import useTags from "@/hooks/useTags";
import TagDisplay from "@/components/ui/tag";
import { Tag } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useInvalidate } from "@refinedev/core";
import { toaster } from "@/components/ui/toaster";

export default function TagSingleProfileModal({
  userName,
  private_id,
  public_id
}: {
  userName: string | null;
  private_id: string;
  public_id: string;
}) {
  const [title, setTitle] = useState<string>("");
  const [visible, setVisible] = useState<SingleValue<{ label: string; value: boolean }>>();
  const [color, setColor] = useState<SingleValue<{ label: string; value: string }>>();
  const [createStrategy, setCreateStrategy] = useState<"create_new" | "use_old">("create_new");
  const [selectedTag, setSelectedTag] = useState<SingleValue<{ label: string; value: Tag }>>();
  const tags = useTags();
  const { course_id } = useParams();
  const { mutate } = useCreate();
  const invalidate = useInvalidate();

  const tagUser = async () => {
    if (createStrategy === "create_new") {
      // default color red, default visibility private to instructor
      createNewTag(title, color ? color.value : TagColor.RED.hex, visible ? visible.value : false);
    } else if (createStrategy === "use_old") {
      if (!selectedTag) {
        toaster.error({
          title: "Failed to tag user",
          description: "Cannot tag user based on previous tag because no tag is selected."
        });
        return;
      }
      createNewTag(selectedTag.value.name, selectedTag.value.color, selectedTag.value.visible);
    }
  };

  const createNewTag = async (name: string, color: string, visible: boolean) => {
    mutate(
      {
        resource: "tags",
        values: {
          id: crypto.randomUUID(),
          name: name,
          color: color,
          visible: visible,
          profile_id: name === "~" ? private_id : public_id,
          class_id: course_id
        }
      },
      {
        onSuccess: () => {
          toaster.success({
            title: "Tag created",
            description: "Successfully tagged " + userName + " with " + name
          });
          invalidate({
            resource: "tags",
            invalidates: ["list"] // To refresh the table
          });
        },
        onError: (error) => {
          toaster.error({
            title: "Error tagging user",
            type: "Found error " + error + " with message " + error.message
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
        setCreateStrategy("create_new");
      }}
    >
      <Dialog.Trigger as="div">
        <FaTag />
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Tag {userName}</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Fieldset.Root>
              <Field.Root>
                <SegmentGroup.Root
                  value={createStrategy}
                  onValueChange={(details) => {
                    setCreateStrategy(details.value as "create_new" | "use_old");
                  }}
                >
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Item value="create_new">
                    <SegmentGroup.ItemText>Create new tag</SegmentGroup.ItemText>
                    <SegmentGroup.ItemHiddenInput />
                  </SegmentGroup.Item>
                  <SegmentGroup.Item value="use_old">
                    <SegmentGroup.ItemText>Use existing tag</SegmentGroup.ItemText>
                    <SegmentGroup.ItemHiddenInput />
                  </SegmentGroup.Item>
                </SegmentGroup.Root>
              </Field.Root>

              {createStrategy === "create_new" && (
                <>
                  <Field.Root>
                    <Field.Label>Tag name</Field.Label>
                    <Input
                      onChange={(e) => {
                        setTitle(e.target.value);
                      }}
                    />
                    <Field.HelperText>
                      To assign the tag to their private profile (non anonymous), prefix the name with &apos;~&apos;
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
                        return { label: color.text, value: color.hex };
                      })}
                    />
                  </Field.Root>
                </>
              )}
              {createStrategy === "use_old" && (
                <>
                  {" "}
                  <Field.Root>
                    <Field.Label>Choose tag</Field.Label>
                    <Select
                      isMulti={false}
                      onChange={(e) => {
                        setSelectedTag(e);
                      }}
                      options={tags.tags.map((p) => ({ label: p.name, value: p }))}
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
                            TagColor.colors().find((c) => {
                              return c.hex == selectedTag?.value.color;
                            })?.text ?? ""
                          }
                          color={selectedTag?.value.color}
                        />
                      </Field.Root>
                    </>
                  )}
                </>
              )}
            </Fieldset.Root>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.CloseTrigger as="div">
              <Button colorPalette="red">Cancel</Button>
            </Dialog.CloseTrigger>
            <Dialog.CloseTrigger as="div">
              <Button
                colorPalette="green"
                disabled={!(selectedTag || (title && color && visible))}
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
