import { Button, Dialog, Field, Fieldset, Input, Portal } from "@chakra-ui/react";
import { useState } from "react";
import { MultiValue, Select } from "chakra-react-select";
import useUserProfiles from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import useTags from "@/hooks/useTags";

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

  return (
    <Dialog.Root placement={"center"}>
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
                <Select isMulti={false} options={tags.tags.map((p) => ({ label: p.name, value: p.id }))} />
              </Field.Root>
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
