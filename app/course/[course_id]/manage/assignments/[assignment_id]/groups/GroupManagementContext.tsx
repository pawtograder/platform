import { toaster } from "@/components/ui/toaster";
import { createContext, useContext, useState } from "react";

export type GroupCreateData = {
  name: string;
  member_ids: string[];
  tagName?: string;
  tagColor?: string;
};

export type StudentMoveData = {
  profile_id: string;
  new_group_id: number | null;
  old_group_id: number | null;
};

export type GroupManagementContextType = {
  groupsToCreate: GroupCreateData[];
  clearGroupsToCreate: () => void;
  addGroupsToCreate: (data: GroupCreateData[]) => void;
  movesToFulfill: StudentMoveData[];
  clearMovesToFulfill: () => void;
  addMovesToFulfill: (data: StudentMoveData[]) => void;
  removeMoveToFulfill: (data: StudentMoveData) => void;
  removeGroupToCreate: (data: GroupCreateData) => void;
  modProfiles: string[];
};

export const GroupManagementContext = createContext<GroupManagementContextType>({} as GroupManagementContextType);

export const useGroupManagement = () => {
  const ctx = useContext(GroupManagementContext);
  if (!ctx) {
    throw new Error("useGroupManagement must be used within a GroupManagementProvider");
  }
  return ctx;
};

export function GroupManagementProvider({ children }: { children: React.ReactNode }) {
  const [groupsToCreate, setGroupsToCreate] = useState<GroupCreateData[]>([]);
  const [movesToFulfill, setMovesToFulfill] = useState<StudentMoveData[]>([]);
  // list of profile ids that are being modified by this staging
  const [modProfiles, setModProfiles] = useState<string[]>([]);

  const addMovesToFulfill = (data: StudentMoveData[]) => {
    const profiles = data.map((move) => {
      return move.profile_id;
    });
    if (
      profiles.find((profile) => {
        return modProfiles.includes(profile);
      }) !== undefined
    ) {
      toaster.error({
        title: "Failed to add moves to staging",
        description: "Found one or more profiles that already have staged changes"
      });
    } else {
      setMovesToFulfill(movesToFulfill.concat(data));
      setModProfiles(modProfiles.concat(profiles));
    }
  };

  const addGroupsToCreate = (data: GroupCreateData[]) => {
    let profiles: string[] = [];
    profiles = data.reduce((acc, group) => {
      return acc.concat(group.member_ids);
    }, profiles);
    if (
      profiles.find((profile) => {
        return modProfiles.includes(profile);
      }) !== undefined
    ) {
      toaster.error({
        title: "Failed to add groups to staging",
        description: "Found one or more profiles that already have staged changes"
      });
    } else {
      setGroupsToCreate(groupsToCreate.concat(data));
      setModProfiles(modProfiles.concat(profiles));
    }
  };

  const clearGroupsToCreate = () => {
    let profiles: string[] = [];
    profiles = groupsToCreate.reduce((acc, group) => {
      return acc.concat(group.member_ids);
    }, profiles);
    setModProfiles(
      modProfiles.filter((prof) => {
        return !profiles.includes(prof);
      })
    );
    setGroupsToCreate([]);
  };

  const removeGroupToCreate = (data: GroupCreateData) => {
    setGroupsToCreate(
      groupsToCreate.filter((group) => {
        return group.name !== data.name;
      })
    );
    setModProfiles(
      modProfiles.filter((prof) => {
        return !data.member_ids.includes(prof);
      })
    );
  };

  const removeMoveToFulfill = (data: StudentMoveData) => {
    setMovesToFulfill(
      movesToFulfill.filter((move) => {
        return move.profile_id !== data.profile_id;
      })
    );
    setModProfiles(
      modProfiles.filter((prof) => {
        return prof !== data.profile_id;
      })
    );
  };

  const clearMovesToFulfill = () => {
    setModProfiles(
      modProfiles.filter((profile) => {
        return !movesToFulfill
          .map((move) => {
            return move.profile_id;
          })
          .includes(profile);
      })
    );
    setMovesToFulfill([]);
  };

  return (
    <GroupManagementContext.Provider
      value={{
        groupsToCreate,
        clearGroupsToCreate,
        addGroupsToCreate,
        removeGroupToCreate,
        movesToFulfill,
        clearMovesToFulfill,
        addMovesToFulfill,
        removeMoveToFulfill,
        modProfiles
      }}
    >
      {children}
    </GroupManagementContext.Provider>
  );
}
