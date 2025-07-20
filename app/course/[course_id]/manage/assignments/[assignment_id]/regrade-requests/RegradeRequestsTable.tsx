"use client";

import PersonName from "@/components/ui/person-name";
import type { RegradeStatus } from "@/utils/supabase/DatabaseTypes";
import {
    Box,
    Button,
    HStack,
    Icon,
    Input,
    NativeSelectField,
    NativeSelectRoot,
    Table,
    Tag,
    Text,
    VStack
} from "@chakra-ui/react";
import { useTable } from "@refinedev/react-table";
import { ColumnDef, flexRender, getFilteredRowModel, getCoreRowModel, getPaginationRowModel } from "@tanstack/react-table";
import { formatRelative } from "date-fns";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { FaExternalLinkAlt, FaSort, FaSortDown, FaSortUp, FaCheck, FaTimes } from "react-icons/fa";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { useRubricCheck } from "@/hooks/useAssignment";

// Status configuration
const statusConfig: Record<RegradeStatus, {
    colorPalette: string;
    icon: LucideIcon;
    label: string;
}> = {
    draft: {
        colorPalette: "gray",
        icon: Clock,
        label: "Draft"
    },
    opened: {
        colorPalette: "orange",
        icon: AlertCircle,
        label: "Pending"
    },
    resolved: {
        colorPalette: "blue",
        icon: CheckCircle,
        label: "Resolved"
    },
    escalated: {
        colorPalette: "red",
        icon: ArrowUp,
        label: "Appealed"
    },
    closed: {
        colorPalette: "gray",
        icon: XCircle,
        label: "Closed"
    }
};

// Type for regrade request with populated relations
type RegradeRequestRow = GetResult<
    Database["public"],
    Database["public"]["Tables"]["submission_regrade_requests"]["Row"],
    "submission_regrade_requests",
    Database["public"]["Tables"]["submission_regrade_requests"]["Relationships"],
    "*, submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id), submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id), submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id), submissions!inner(id, profiles(name), assignment_groups(assignment_groups_members(profiles!assignment_groups_members_profile_id_fkey(name))))"
>;

function StatusCell({ status }: { status: RegradeStatus }) {
    const config = statusConfig[status];
    const StatusIcon = config.icon;
    
    return (
        <Tag.Root colorPalette={config.colorPalette} variant="surface">
            <HStack gap={1}>
                <Icon as={StatusIcon} boxSize={3} />
                <Tag.Label>{config.label}</Tag.Label>
            </HStack>
        </Tag.Root>
    );
}

function StudentCell({ submission, submissionId }: { 
    submission?: RegradeRequestRow['submissions'];
    submissionId: number;
}) {
    const { course_id, assignment_id } = useParams();
    
    let displayName = "Unknown";
    if (submission?.assignment_groups?.assignment_groups_members?.length) {
        displayName = `Group: ${submission.assignment_groups.assignment_groups_members.map(member => member.profiles.name).join(", ")}`;
    } else if (submission?.profiles?.name) {
        displayName = submission.profiles.name;
    }
    
    return (
        <HStack>
            <Text>{displayName}</Text>
            <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                    window.open(
                        `/course/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`,
                        "_blank"
                    );
                }}
            >
                <Icon as={FaExternalLinkAlt} boxSize={3} />
            </Button>
        </HStack>
    );
}

function AppealGrantedCell({ row }: { row: RegradeRequestRow }) {
    const isAppealGranted = row.status === 'closed' && 
                           row.closed_points !== null && 
                           row.resolved_points !== null && 
                           row.closed_points !== row.resolved_points;
    
    if (row.status !== 'closed') {
        return <Text color="fg.muted">N/A</Text>;
    }
    
    return (
        <HStack gap={1}>
            <Icon 
                as={isAppealGranted ? FaCheck : FaTimes} 
                boxSize={3} 
                color={isAppealGranted ? "green.500" : "red.500"} 
            />
            <Text color={isAppealGranted ? "green.500" : "red.500"}>
                {isAppealGranted ? "Yes" : "No"}
            </Text>
        </HStack>
    );
}

function RubricCheckCell({ row }: { row: RegradeRequestRow }) {
    const rubricCheckId = row.submission_file_comments?.[0]?.rubric_check_id || row.submission_artifact_comments?.[0]?.rubric_check_id || row.submission_comments?.[0]?.rubric_check_id;
    const rubricCheck = useRubricCheck(rubricCheckId);
    return <Text>{rubricCheck?.name}</Text>;
}

export default function RegradeRequestsTable() {
    const { assignment_id } = useParams();
    const [pageCount, setPageCount] = useState(0);
    
    const columns = useMemo<ColumnDef<RegradeRequestRow>[]>(
        () => [
            {
                id: "assignment_id",
                accessorKey: "assignment_id", 
                header: "Assignment",
                filterFn: (row, id, filterValue) => {
                    return String(row.original.assignment_id) === String(filterValue);
                }
            },
            {
                id: "status",
                accessorKey: "status",
                header: "Status",
                cell: ({ getValue }) => <StatusCell status={getValue() as RegradeStatus} />,
                enableColumnFilter: true,
                filterFn: (row, id, filterValue) => {
                    return row.original.status === filterValue;
                }
            },
            { id: "rubric_check",
                header: "Rubric Check",
                cell: ({ row }) => <RubricCheckCell row={row.original} />
            },
            {
                id: "student",
                header: "Student/Group",
                accessorFn: (row) => {
                    if (row.submissions?.assignment_groups?.assignment_groups_members?.length) {
                        return `Group: ${row.submissions.assignment_groups.assignment_groups_members.map(member => member.profiles.name).join(", ")}`;
                    }
                    return row.submissions?.profiles?.name || "Unknown";
                },
                cell: ({ row }) => (
                    <StudentCell 
                        submission={row.original.submissions}
                        submissionId={row.original.submission_id}
                    />
                ),
                enableColumnFilter: true,
                filterFn: (row, id, filterValue) => {
                    const filterString = String(filterValue).toLowerCase();
                    const studentName = row.original.submissions?.profiles?.name?.toLowerCase();
                    const groupName = row.original.submissions?.assignment_groups?.name?.toLowerCase();
                    
                    if (studentName && studentName.includes(filterString)) return true;
                    if (groupName && groupName.includes(filterString)) return true;
                    return false;
                }
            },
            {
                id: "assignee",
                accessorKey: "assignee",
                header: "Assignee",
                cell: ({ getValue }) => <PersonName showAvatar={false} uid={getValue() as string} />
            },
            {
                id: "initial_points",
                accessorKey: "initial_points",
                header: "Initial Points",
                cell: ({ getValue }) => getValue() ?? "N/A"
            },
            {
                id: "current_points",
                header: "Current Points",
                accessorFn: (row) => {
                    if (row.closed_points !== null) return row.closed_points;
                    if (row.resolved_points !== null) return row.resolved_points;
                    return row.initial_points;
                },
                cell: ({ getValue }) => getValue() ?? "N/A"
            },
            {
                id: "appeal_granted",
                header: "Appeal Granted",
                accessorFn: (row) => {
                    if (row.status !== 'closed') return 'N/A';
                    return row.status === 'closed' && 
                           row.closed_points !== null && 
                           row.resolved_points !== null && 
                           row.closed_points !== row.resolved_points;
                },
                cell: ({ row }) => <AppealGrantedCell row={row.original} />,
                enableColumnFilter: true,
                enableSorting: false,
                filterFn: (row, id, filterValue) => {
                    if (filterValue === "yes") {
                        return row.original.status === 'closed' && 
                               row.original.closed_points !== null && 
                               row.original.resolved_points !== null && 
                               row.original.closed_points !== row.original.resolved_points;
                    }
                    if (filterValue === "no") {
                        return row.original.status === 'closed' && 
                               (row.original.closed_points === null || 
                                row.original.resolved_points === null || 
                                row.original.closed_points === row.original.resolved_points);
                    }
                    return true;
                }
            },
            {
                id: "created_at",
                accessorKey: "created_at",
                header: "Created",
                cell: ({ getValue }) => formatRelative(new Date(getValue() as string), new Date())
            },
            {
                id: "last_updated",
                header: "Last Updated",
                accessorFn: (row) => {
                    if (row.closed_at) return row.closed_at;
                    if (row.escalated_at) return row.escalated_at;
                    if (row.resolved_at) return row.resolved_at;
                    if (row.opened_at) return row.opened_at;
                    return row.created_at;
                },
                cell: ({ getValue }) => formatRelative(new Date(getValue() as string), new Date())
            }
        ],
        [assignment_id]
    );

    const {
        getHeaderGroups,
        getRowModel,
        refineCore: { tableQuery: tableQueryResult, current, pageSize, setCurrent },
        resetColumnFilters,
        getColumn,
        getCanPreviousPage,
        getCanNextPage,
        setPageCount: setTablePageCount,
        resetSorting,
        getPageCount
    } = useTable<RegradeRequestRow>({
        columns,
        initialState: {
            columnFilters: [
                {
                    id: "assignment_id",
                    value: assignment_id as string
                }
            ],
            pagination: {
                pageIndex: 0,
                pageSize: 50
            },
            sorting: [{ id: "created_at", desc: false }]
        },
        refineCoreProps: {
            resource: "submission_regrade_requests",
            pagination: {
                mode: "off"
            },
            filters: {
                mode: "off"
            },
            meta: {
                select: `
                *,
                submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id),
                submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id),
                submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id),
                submissions!inner(
                    id,
                    profiles(name),
                    assignment_groups(assignment_groups_members(profiles!assignment_groups_members_profile_id_fkey(name)))
                )
            `
            },
        },
        manualPagination: false,
        manualFiltering: false,
        getPaginationRowModel: getPaginationRowModel(),
        pageCount,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
    });

    // Update page count when data changes
    const totalCount = tableQueryResult?.data?.total || 0;
    const calculatedPageCount = Math.ceil(totalCount / pageSize);
    if (calculatedPageCount !== pageCount) {
        setPageCount(calculatedPageCount);
        setTablePageCount(calculatedPageCount);
    }

    return (
        <VStack align="stretch" gap={4}>
            {/* Filters */}
            <HStack wrap="wrap" gap={4}>
                <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Filter by Status:
                    </Text>
                    <NativeSelectRoot size="sm" width="150px">
                        <NativeSelectField
                            value={getColumn("status")?.getFilterValue() as string || ""}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                                const value = e.target.value;
                                getColumn("status")?.setFilterValue(value === "" ? undefined : value);
                            }}
                            placeholder="All statuses"
                        >
                            <option value="">All statuses</option>
                            <option value="draft">Draft</option>
                            <option value="opened">Pending</option>
                            <option value="resolved">Resolved</option>
                            <option value="escalated">Appealed</option>
                            <option value="closed">Closed</option>
                        </NativeSelectField>
                    </NativeSelectRoot>
                </Box>
                
                <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Filter by Student:
                    </Text>
                    <Input
                        placeholder="Search students..."
                        value={getColumn("student")?.getFilterValue() as string || ""}
                        onChange={(e) => getColumn("student")?.setFilterValue(e.target.value)}
                        size="sm"
                        width="200px"
                    />
                </Box>

                <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Appeal Granted:
                    </Text>
                    <NativeSelectRoot size="sm" width="120px">
                        <NativeSelectField
                            value={getColumn("appeal_granted")?.getFilterValue() as string || ""}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                                const value = e.target.value;
                                getColumn("appeal_granted")?.setFilterValue(value === "" ? undefined : value);
                            }}
                            placeholder="All"
                        >
                            <option value="">All</option>
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                        </NativeSelectField>
                    </NativeSelectRoot>
                </Box>

                <Box>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            resetColumnFilters();
                            resetSorting();
                        }}
                    >
                        Clear Filters
                    </Button>
                </Box>
            </HStack>

            {/* Table */}
            <Box overflowX="auto">
                <Table.Root size="sm">
                    <Table.Header>
                        {getHeaderGroups().map((headerGroup) => (
                            <Table.Row key={headerGroup.id}>
                                {headerGroup.headers.filter(header => header.id !== "assignment_id").map((header) => (
                                    <Table.ColumnHeader key={header.id}>
                                        {header.isPlaceholder ? null : (
                                            <HStack
                                                cursor={header.column.getCanSort() ? "pointer" : "default"}
                                                onClick={header.column.getToggleSortingHandler()}
                                                userSelect="none"
                                            >
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                                {header.column.getCanSort() && (
                                                    <Icon
                                                        as={
                                                            header.column.getIsSorted() === "desc"
                                                                ? FaSortDown
                                                                : header.column.getIsSorted() === "asc"
                                                                ? FaSortUp
                                                                : FaSort
                                                        }
                                                        boxSize={3}
                                                    />
                                                )}
                                            </HStack>
                                        )}
                                    </Table.ColumnHeader>
                                ))}
                            </Table.Row>
                        ))}
                    </Table.Header>
                    <Table.Body>
                        {getRowModel().rows.map((row) => (
                            <Table.Row key={row.id}>
                                {row.getVisibleCells().filter(cell => cell.column.id !== "assignment_id").map((cell) => (
                                    <Table.Cell key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </Table.Cell>
                                ))}
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table.Root>
            </Box>

            {/* Pagination */}
            <HStack justifyContent="space-between" alignItems="center">
                <Text fontSize="sm" color="fg.muted">
                    Showing {Math.min((current - 1) * pageSize + 1, totalCount)} to{" "}
                    {Math.min(current * pageSize, totalCount)} of {totalCount} results
                </Text>
                
                <HStack>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => getCanPreviousPage() && setCurrent(current - 1)}
                        disabled={!getCanPreviousPage()}
                    >
                        Previous
                    </Button>
                    
                    <HStack gap={1}>
                        <Text fontSize="sm">Page</Text>
                        <Input
                            size="sm"
                            width="60px"
                            value={current}
                            onChange={(e) => {
                                const page = parseInt(e.target.value, 10);
                                if (!isNaN(page) && page > 0 && page <= getPageCount()) {
                                    setCurrent(page);
                                }
                            }}
                        />
                        <Text fontSize="sm">of {getPageCount()}</Text>
                    </HStack>
                    
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => getCanNextPage() && setCurrent(current + 1)}
                        disabled={!getCanNextPage()}
                    >
                        Next
                    </Button>
                </HStack>
            </HStack>
        </VStack>
    );
} 