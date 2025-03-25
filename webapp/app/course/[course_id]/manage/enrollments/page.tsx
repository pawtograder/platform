'use client'
import { PopConfirm } from "@/components/ui/popconfirm";
import { UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import { Button, Container, Heading, HStack, Icon, IconButton, Input, Link, NativeSelect, Select, Table, Text, VStack } from "@chakra-ui/react";
import { useTable, } from "@refinedev/react-table";
import { ColumnDef, ColumnFiltersState, flexRender} from "@tanstack/react-table";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { FaExternalLinkAlt } from "react-icons/fa";
import { MdOutlineInsertLink } from "react-icons/md";


function EnrollmentsTable() {
    const { course_id } = useParams();
    const [columnFilters, _setColumnFilters] = useState<ColumnFiltersState>([]) // can set initial column filter state here
    const setColumnFilters = (columnFilters: ColumnFiltersState) => {
        console.log(JSON.stringify(columnFilters));
        _setColumnFilters(columnFilters);
    }

    const columns = useMemo<ColumnDef<UserRoleWithPrivateProfileAndUser>[]>(
        () => [
            {
                id: "class_id",
                accessorKey: "class_id",
                header: "Class ID",
                enableColumnFilter: true,
                enableHiding: true
                
            },
            {
                id: "Name",
                accessorKey: "profiles.name",
                // filterKey: "profiles.name",
                header: "Name",
                meta: {
                    filterOperator: "contains",
                },
                // filterFn: (row, columnId, filterValue) => {
                //     // console.log(row, columnId, filterValue);
                //     console.log(row.original.profiles.name, filterValue);
                //     return true;
                // },
                enableColumnFilter: true,
            },
            {
                id: "role",
                header: "Role",
                accessorKey: "role",
            },
            {
                id: "github_username",
                header: "Github Username",
                accessorKey: "users.github_username",
            },
        ],
        [],
    );
    const {
        getHeaderGroups,
        getRowModel,
        getState,
        setPageIndex,
        getCanPreviousPage,
        getPageCount,
        getCanNextPage,
        nextPage,
        previousPage,
        setPageSize,
        getPrePaginationRowModel,
    } = useTable({
        columns,
        // state:{
            // columnFilters,
        // },
        initialState: {
            columnFilters: [{ id: "class_id", value: course_id as string }],
        },
        // onColumnFiltersChange: setColumnFilters,
        refineCoreProps: {
            resource: "user_roles",
            filters: {
                mode: 'off',
            //     // defaultBehavior: "merge",
                permanent: [{ field: "class_id", operator: "eq", value: course_id as string}],
              },
            meta: {
                select: "*,profiles!private_profile_id(*), users(*)"
            },
        },
    });
    return (<VStack>
        <Table.Root>
            <Table.Header>
                {getHeaderGroups().map((headerGroup) => (
                    <Table.Row bg="bg.subtle" key={headerGroup.id}>
                        {headerGroup.headers.filter(h => h.id !== "class_id").map((header) => {
                            return (
                                <Table.ColumnHeader key={header.id}>
                                    {header.isPlaceholder ? null : (
                                        <>
                                            <Text onClick={header.column.getToggleSortingHandler()}>
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext(),
                                                )}
                                                {{
                                                    asc: " 🔼",
                                                    desc: " 🔽",
                                                }[header.column.getIsSorted() as string] ?? null}
                                            </Text>
                                            <Input
                                                id={header.id}
                                                    value={
                                                        (header.column.getFilterValue() as string) ?? ""
                                                    }
                                                    onChange={(e) => {
                                                        header.column.setFilterValue(''+e.target.value)
                                                    }
                                                    }
                                            />
                                        </>
                                    )}
                                </Table.ColumnHeader>
                            );
                        })}
                    </Table.Row>
                ))}
            </Table.Header>
            <Table.Body>
                {getRowModel().rows//.filter(row => row.getValue("profiles.name") !== undefined)
                .map((row) => {
                    return (
                        <Table.Row key={row.id}>
                            {row.getVisibleCells().filter(c => c.column.id !== "class_id").map((cell) => {
                                return (
                                    <Table.Cell key={cell.id}>
                                        {flexRender(
                                            cell.column.columnDef.cell,
                                            cell.getContext(),
                                        )}
                                    </Table.Cell>
                                );
                            })}
                        </Table.Row>
                    );
                })}
            </Table.Body>
        </Table.Root>
        <HStack>
            <Button
                onClick={() => setPageIndex(0)}
                disabled={!getCanPreviousPage()}
            >
                {"<<"}
            </Button>
            <Button
                id="previous-button"
                onClick={() => previousPage()}
                disabled={!getCanPreviousPage()}
            >
                {"<"}
            </Button>
            <Button
                id="next-button"
                onClick={() => nextPage()}
                disabled={!getCanNextPage()}
            >
                {">"}
            </Button>
            <Button
                onClick={() => setPageIndex(getPageCount() - 1)}
                disabled={!getCanNextPage()}
            >
                {">>"}
            </Button>
            <VStack>
                <Text>Page</Text>
                <Text>
                    {getState().pagination.pageIndex + 1} of {getPageCount()}
                </Text>
            </VStack>
            <VStack>
                | Go to page:
                <input
                    type="number"
                    defaultValue={getState().pagination.pageIndex + 1}
                    onChange={(e) => {
                        const page = e.target.value ? Number(e.target.value) - 1 : 0;
                        setPageIndex(page);
                    }}
                />
            </VStack>
            <VStack>
                <Text>Show</Text>
                <NativeSelect.Root
                >
                    <NativeSelect.Field value={'' + getState().pagination.pageSize}
                        onChange={(event) => {
                            console.log(event.target.value);
                            setPageSize(Number(event.target.value));
                        }}>

                        {[25, 50, 100, 200, 500].map((pageSize) => (
                            <option key={pageSize} value={pageSize}>
                                Show {pageSize}
                            </option>
                        ))}
                    </NativeSelect.Field>
                </NativeSelect.Root>
            </VStack>
        </HStack>
        <div>{getPrePaginationRowModel().rows.length} Rows</div>
    </VStack>
    );
}
export default function EnrollmentsPage() {

    return (
        <Container>
            <Heading>Enrollments</Heading>
            <EnrollmentsTable />
        </Container>
    );
}