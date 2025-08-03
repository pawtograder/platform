import { useUserProfile } from "@/hooks/useUserProfiles";
import { Box, Text } from "@chakra-ui/react";

//TODO: add lab section and class section, conflicts maybe? extensions?
export default function StudentInfoCard({ private_profile_id }: { private_profile_id: string }) {
  const student = useUserProfile(private_profile_id);
  if (!student) {
    return null;
  }
  return (
    <Box>
      <Text>{student?.name}</Text>
    </Box>
  );
}
