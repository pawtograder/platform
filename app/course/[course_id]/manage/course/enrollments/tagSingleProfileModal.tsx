import { Button, Dialog, Field, Fieldset, Input, SegmentGroup,Text } from "@chakra-ui/react";
import { useState } from "react";
import { SingleValue, MultiValue, Select } from "chakra-react-select";
import useUserProfiles from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { TagColor } from "./TagColors";
import { FaTag } from "react-icons/fa6";
import useTags from "@/hooks/useTags";
import TagDisplay from "@/components/ui/tag";
import { Tag } from "@/utils/supabase/DatabaseTypes";

export default function TagSingleProfileModal({
  name,
  private_id,
  public_id
}: {
  name:string | null,
  private_id:string,
  public_id: string,
}) {
  const [title, setTitle] = useState<string>("");
  const [selected, setSelected] = useState<
    MultiValue<{
      label: string | null;
      value: string;
    }>
  >();
  const [visible, setVisible] = useState<SingleValue<{ label: string; value: boolean }>>();

  const [color, setColor] = useState<SingleValue<{ label: string; value: string }>>();

  const profiles = useUserProfiles();
  const supabase = createClient();
  const { course_id } = useParams();
  const createTag = async () => {
    //supabase.from("tags").insert({class_id:Number(course_id), color:"blue", visible:true, name:"title", profile_id:"1"})
  };
  const [createStrategy, setCreateStrategy] = useState<"create_new" | "use_old">("create_new");
  const [selectedTag, setSelectedTag] = useState<SingleValue<{ label: string; value: Tag }>>();
  const tags = useTags();

  return (
    <Dialog.Root placement={"center"} onExitComplete={
      () => {
        setTitle("");
        setSelected(undefined);
        setVisible(null);
        setColor(null);
      }
    }> 
      <Dialog.Trigger as="div">
        <FaTag />
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Tag {name}</Dialog.Title>
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

             {createStrategy === "create_new" && <><Field.Root>
                <Field.Label>Tag name</Field.Label>
                <Input
                  onChange={(e) => {
                    setTitle(e.target.value);
                  }}
                />
                <Field.HelperText>To assign the tag to their private profile (non anonymous), prefix the name with '~'</Field.HelperText>
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
              </Field.Root></>}
              {createStrategy === "use_old" &&
                            <> <Field.Root>
                                <Field.Label>Choose tag</Field.Label>
                                <Select
                                  isMulti={false}
                                  onChange={(e) => {
                                    setSelectedTag(e);
                                  }}
                                  options={tags.tags.map((p) => ({ label: p.name, value: p }))}
                                />
                                <Field.HelperText>Tags prefixed with '~' will be assigned to the user's private profile.  All others will be assigned to 
                                  public profiles.
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
              }

            </Fieldset.Root>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.CloseTrigger as="div">
              <Button colorPalette="red">Cancel</Button>
            </Dialog.CloseTrigger>
            <Dialog.CloseTrigger as="div">
              <Button
                colorPalette="green"
                onClick={() => {
                  createTag();
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
