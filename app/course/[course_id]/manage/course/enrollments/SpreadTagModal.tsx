import { Button, Dialog, Field, Fieldset, Text } from "@chakra-ui/react";
import { useState } from "react";
import { MultiValue, Select, SingleValue } from "chakra-react-select";
import useUserProfiles from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import useTags from "@/hooks/useTags";
import { Tag } from "@/utils/supabase/DatabaseTypes";
import { TagColor } from "./TagColors";
import TagDisplay from "@/components/ui/tag";

export default function CreateNewTagModal() {
  const [title, setTitle] = useState<string>("");
  const [selected, setSelected] = useState<
    MultiValue<{
      label: string | null;
      value: string;
    }>
  >();
  const profiles = useUserProfiles();
  const supabase = createClient();
  const { course_id } = useParams();
  const createTag = async () => {
    console.log("create tags");
    //supabase.from("tags").insert({class_id:Number(course_id), color:"blue", visible:true, name:"title", profile_id:"1"})
  };
  const tags = useTags();
  const [selectedTag, setSelectedTag] = useState<SingleValue<{ label: string; value: Tag }>>();

  return (
    <Dialog.Root placement={"center"} onExitComplete={
      () => {
        setSelectedTag(null);
      }
    }>
      <Dialog.Trigger as="div">
        <Button>Use existing tag</Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Add existing tag to more profiles</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Fieldset.Root>
              <Field.Root>
                <Field.Label>Choose tag</Field.Label>
                <Select
                  isMulti={false}
                  onChange={(e) => {
                    setSelectedTag(e);
                  }}
                  options={tags.tags.map((p) => ({ label: p.name, value: p }))}
                />
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

              <Field.Root>
                <Field.Label>Select profiles to tag</Field.Label>
                <Select
                  onChange={(e) => setSelected(e)}
                  isMulti={true}
                  options={profiles.users.map((p) => ({ label: p.name, value: p.id }))}
                />
              </Field.Root>
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
