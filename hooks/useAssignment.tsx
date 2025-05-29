"use client";
import {
    ActiveSubmissionsWithGradesForAssignment,
    Assignment,
    HydratedRubric,
    HydratedRubricCheck,
    RubricReviewRound
} from "@/utils/supabase/DatabaseTypes";
import { Text } from "@chakra-ui/react";
import { LiveEvent, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";

export function useRubricCheck(rubric_check_id: number) {
    const controller = useAssignmentController();
    return controller.rubricCheckById.get(rubric_check_id);
}

export function useRubric(review_round: RubricReviewRound) {
    const controller = useAssignmentController();
    const rubrics = controller.rubrics;
    const rubric = rubrics.find((rubric) => rubric.review_round === review_round);
    return rubric;
}

type ListUpdateCallback<T> = (
    data: T[],
    {
        entered,
        left,
        updated
    }: {
        entered: T[];
        left: T[];
        updated: T[];
    }
) => void;
type ItemUpdateCallback<T> = (data: T | undefined) => void;
export type Unsubscribe = () => void;

class AssignmentController {
    private _assignment?: Assignment;
    private _rubrics: HydratedRubric[] = [];
    private _submissions: ActiveSubmissionsWithGradesForAssignment[] = [];
    rubricCheckById: Map<number, HydratedRubricCheck> = new Map();

    private genericDataSubscribers: { [key: string]: Map<number, ItemUpdateCallback<unknown>[]> } = {};
    private genericData: { [key: string]: Map<number, unknown> } = {};
    private genericDataListSubscribers: { [key: string]: ListUpdateCallback<unknown>[] } = {};
    private genericDataTypeToId: { [key: string]: (item: unknown) => number } = {};

    registerGenericDataType(typeName: string, idGetter: (item: unknown) => number) {
        if (!this.genericDataTypeToId[typeName]) {
            this.genericDataTypeToId[typeName] = idGetter;
            this.genericDataSubscribers[typeName] = new Map();
            this.genericDataListSubscribers[typeName] = [];
        }
    }
    setGeneric(typeName: string, data: unknown[]) {
        if (!this.genericData[typeName]) {
            this.genericData[typeName] = new Map();
        }
        const idGetter = this.genericDataTypeToId[typeName];
        for (const item of data) {
            const id = idGetter(item);
            this.genericData[typeName].set(id, item);
            const itemSubscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
            itemSubscribers.forEach((cb) => cb(item));
        }
        const listSubscribers = this.genericDataListSubscribers[typeName] || [];
        listSubscribers.forEach((cb) =>
            cb(Array.from(this.genericData[typeName].values()), { entered: data, left: [], updated: [] })
        );
    }
    listGenericData<T>(
        typeName: string,
        callback?: ListUpdateCallback<T>,
        filter?: (item: T) => boolean
    ): { unsubscribe: Unsubscribe; data: T[] } {
        const subscribers = this.genericDataListSubscribers[typeName] || [];
        let filteredCallback = callback as ListUpdateCallback<unknown> | undefined;
        if (filteredCallback && callback) {
            if (filter) {
                filteredCallback = (data, { entered, left, updated }) => {
                    const filteredData = data.filter(filter as (value: unknown) => boolean);
                    const filteredEntered = entered.filter(filter as (value: unknown) => boolean);
                    const filteredLeft = left.filter(filter as (value: unknown) => boolean);
                    const filteredUpdated = updated.filter(filter as (value: unknown) => boolean);
                    (callback as ListUpdateCallback<unknown>)(filteredData, {
                        entered: filteredEntered,
                        left: filteredLeft,
                        updated: filteredUpdated
                    });
                };
            }
            subscribers.push(filteredCallback);
        }
        this.genericDataListSubscribers[typeName] = subscribers;
        const currentData = this.genericData[typeName]?.values() || [];
        if (filter) {
            return {
                unsubscribe: () => {
                    this.genericDataListSubscribers[typeName] =
                        this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== filteredCallback) || [];
                },
                data: (Array.from(currentData) as T[]).filter(filter)
            };
        }
        return {
            unsubscribe: () => {
                this.genericDataListSubscribers[typeName] =
                    this.genericDataListSubscribers[typeName]?.filter((cb) => cb !== filteredCallback) || [];
            },
            data: Array.from(currentData) as T[]
        };
    }
    getValueWithSubscription<T>(
        typeName: string,
        id: number | ((item: T) => boolean),
        callback?: ItemUpdateCallback<T>
    ): { unsubscribe: Unsubscribe; data: T | undefined } {
        if (!this.genericDataTypeToId[typeName]) {
            throw new Error(`No id getter for type ${typeName}`);
        }
        if (typeof id === "function") {
            const idPredicate = id as (item: unknown) => boolean;
            const relevantIds = Array.from(this.genericData[typeName]?.keys() || []).filter((_id) => {
                const item = this.genericData[typeName]?.get(_id);
                return item !== undefined && idPredicate(item);
            });
            if (relevantIds.length == 0) {
                return {
                    unsubscribe: () => { },
                    data: undefined
                };
            } else if (relevantIds.length == 1) {
                const foundId = relevantIds[0];
                const subscribers = this.genericDataSubscribers[typeName]?.get(foundId) || [];
                if (callback) {
                    this.genericDataSubscribers[typeName]?.set(foundId, [
                        ...subscribers,
                        callback as ItemUpdateCallback<unknown>
                    ]);
                }
                return {
                    unsubscribe: () => {
                        this.genericDataSubscribers[typeName]?.set(
                            foundId,
                            subscribers.filter((cb) => cb !== callback)
                        );
                    },
                    data: this.genericData[typeName]?.get(foundId) as T | undefined
                };
            } else {
                throw new Error(`Multiple ids found for type ${typeName}`);
            }
        } else if (typeof id === "number") {
            const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
            if (callback) {
                this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback as ItemUpdateCallback<unknown>]);
            }
            return {
                unsubscribe: () => {
                    this.genericDataSubscribers[typeName]?.set(
                        id,
                        subscribers.filter((cb) => cb !== callback)
                    );
                },
                data: this.genericData[typeName]?.get(id) as T | undefined
            };
        } else {
            throw new Error(`Invalid id type ${typeof id}`);
        }
    }
    handleGenericDataEvent(typeName: string, event: LiveEvent) {
        const body = event.payload as unknown;
        const idGetter = this.genericDataTypeToId[typeName];
        if (!idGetter) return;
        const id = idGetter(body);
        if (!this.genericData[typeName]) {
            this.genericData[typeName] = new Map();
        }
        if (!this.genericDataSubscribers[typeName]) {
            this.genericDataSubscribers[typeName] = new Map();
        }
        if (!this.genericDataListSubscribers[typeName]) {
            this.genericDataListSubscribers[typeName] = [];
        }
        if (event.type === "created") {
            this.genericData[typeName].set(id, body);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
            this.genericDataListSubscribers[typeName]?.forEach((cb) => {
                const allData = Array.from(this.genericData[typeName].values());
                cb(allData, { entered: [body], left: [], updated: [] });
            });
            if (typeName === "rubrics") {
                this._rubrics = Array.from(this.genericData[typeName].values()) as HydratedRubric[];
                this.rebuildRubricCheckById();
            }
        } else if (event.type === "updated") {
            this.genericData[typeName].set(id, body);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(body));
            this.genericDataListSubscribers[typeName]?.forEach((cb) =>
                cb(Array.from(this.genericData[typeName].values()), { entered: [], left: [], updated: [body] })
            );
            if (typeName === "rubrics") {
                this._rubrics = Array.from(this.genericData[typeName].values()) as HydratedRubric[];
                this.rebuildRubricCheckById();
            }
        } else if (event.type === "deleted") {
            this.genericData[typeName].delete(id);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach((cb) => cb(undefined));
            this.genericDataListSubscribers[typeName]?.forEach((cb) =>
                cb(Array.from(this.genericData[typeName].values()), { entered: [], left: [body], updated: [] })
            );
            if (typeName === "rubrics") {
                this._rubrics = Array.from(this.genericData[typeName].values()) as HydratedRubric[];
                this.rebuildRubricCheckById();
            }
        }
    }
    // Assignment
    set assignment(assignment: Assignment) {
        this._assignment = assignment;
    }
    get assignment() {
        if (!this._assignment) throw new Error("Assignment not set");
        return this._assignment;
    }
    // Rubrics
    set rubrics(rubrics: HydratedRubric[]) {
        this._rubrics = rubrics;
        this.rebuildRubricCheckById();
    }
    get rubrics() {
        return this._rubrics;
    }
    private rebuildRubricCheckById() {
        this.rubricCheckById.clear();
        for (const rubric of this._rubrics) {
            if (rubric.rubric_parts) {
                for (const part of rubric.rubric_parts) {
                    if (part.rubric_criteria) {
                        for (const criteria of part.rubric_criteria) {
                            if (criteria.rubric_checks) {
                                for (const check of criteria.rubric_checks) {
                                    this.rubricCheckById.set(check.id, check);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Submissions
    set submissions(submissions: ActiveSubmissionsWithGradesForAssignment[]) {
        this._submissions = submissions;
    }
    get submissions() {
        return this._submissions;
    }
    get isReady() {
        return !!this._assignment && this._rubrics.length > 0;
    }
}

// --- Context ---

type AssignmentContextType = {
    assignmentController: AssignmentController;
};
const AssignmentContext = createContext<AssignmentContextType | null>(null);
export function useAssignmentController() {
    const ctx = useContext(AssignmentContext);
    if (!ctx) throw new Error("useAssignmentController must be used within AssignmentProvider");
    return ctx.assignmentController;
}

// --- Provider ---

export function AssignmentProvider({
    assignment_id: initial_assignment_id,
    children
}: {
    assignment_id?: number;
    children: React.ReactNode;
}) {
    const params = useParams();
    const controller = useRef<AssignmentController>(new AssignmentController());
    const [ready, setReady] = useState(false);
    const assignment_id = initial_assignment_id ?? Number(params.assignment_id);

    if (!assignment_id || isNaN(assignment_id)) {
        return <Text>Error: Invalid Assignment ID.</Text>;
    }

    return (
        <AssignmentContext.Provider value={{ assignmentController: controller.current }}>
            <AssignmentControllerCreator assignment_id={assignment_id} setReady={setReady} controller={controller.current} />
            {ready && children}
        </AssignmentContext.Provider>
    );
}

function AssignmentControllerCreator({
    assignment_id,
    setReady,
    controller
}: {
    assignment_id: number;
    setReady: (ready: boolean) => void;
    controller: AssignmentController;
}) {
    // Assignment
    const { query: assignmentQuery } = useShow<Assignment>({
        resource: "assignments",
        id: assignment_id,
        queryOptions: { enabled: !!assignment_id },
        meta: {
            select: "*, rubrics!rubrics_assignment_id_fkey(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_check_references!referencing_rubric_check_id(*)))))"
        }
    });

    // Submissions (minimal info)
    const { data: submissionsData } = useList<ActiveSubmissionsWithGradesForAssignment>({
        resource: "submissions_with_grades_for_assignment",
        filters: [{ field: "assignment_id", operator: "eq", value: assignment_id }],
        pagination: { pageSize: 1000 },
        liveMode: "manual",
        queryOptions: { enabled: !!assignment_id },
        onLiveEvent: (event) => {
            controller.handleGenericDataEvent("submissions", event);
        }
    });

    // Register types for generic data (rubrics, submissions)
    useEffect(() => {
        controller.registerGenericDataType("rubrics", (item: unknown) => (item as HydratedRubric).id);
        controller.registerGenericDataType("submissions", (item: unknown) => (item as ActiveSubmissionsWithGradesForAssignment).id);
    }, [controller]);

    // Set data in controller
    useEffect(() => {
        if (assignmentQuery.data?.data) {
            controller.assignment = assignmentQuery.data.data;
        }
        if (submissionsData?.data) {
            controller.submissions = submissionsData.data;
            controller.setGeneric("submissions", submissionsData.data);
        }
        if (!assignmentQuery.isLoading && assignmentQuery.data?.data) {
            setReady(true);
        }
    }, [assignmentQuery.data, assignmentQuery.isLoading, submissionsData, controller, setReady]);

    return null;
}
