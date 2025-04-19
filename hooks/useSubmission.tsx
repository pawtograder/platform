'use client';
import { toaster } from "@/components/ui/toaster";
import { RubricChecks, RubricCriteriaWithRubricChecks, SubmissionComments, SubmissionFile, SubmissionFileComment, SubmissionReview, SubmissionReviewWithRubric, SubmissionWithFilesGraderResultsOutputTestsAndRubric } from "@/utils/supabase/DatabaseTypes";
import { Spinner, Text } from "@chakra-ui/react";
import { LiveEvent, useList, useShow } from "@refinedev/core";
import { useParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Unsubscribe } from "./useCourseController";
import { check } from "prettier";

type ListUpdateCallback<T> = (data: T[], { entered, left, updated }: {
    entered: T[],
    left: T[],
    updated: T[],
}) => void;
type ItemUpdateCallback<T> = (data: T) => void;

class SubmissionController {
    private _submission?: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
    private _file?: SubmissionFile;

    private genericDataSubscribers: { [key in string]: Map<number, ItemUpdateCallback<any>[]> } = {};
    private genericData: { [key in string]: Map<number, any> } = {};
    private genericDataListSubscribers: { [key in string]: ListUpdateCallback<any>[] } = {};

    private genericDataTypeToId: { [key in string]: (item: any) => number } = {};

    registerGenericDataType(typeName: string, idGetter: (item: any) => number) {
        if (!this.genericDataTypeToId[typeName]) {
            this.genericDataTypeToId[typeName] = idGetter;
            this.genericDataSubscribers[typeName] = new Map();
            this.genericDataListSubscribers[typeName] = [];
        }
    }

    setGeneric(typeName: string, data: any[]) {
        if (!this.genericData[typeName]) {
            this.genericData[typeName] = new Map();
        }
        const idGetter = this.genericDataTypeToId[typeName];
        for (const item of data) {
            const id = idGetter(item);
            this.genericData[typeName].set(id, item);
            const itemSubscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
            itemSubscribers.forEach(cb => cb(item));
        }
        const listSubscribers = this.genericDataListSubscribers[typeName] || [];
        //TODO is this over-called?
        listSubscribers.forEach(cb => cb(Array.from(this.genericData[typeName].values()), { entered: data, left: [], updated: [] }));
    }
    listGenericData<T>(typeName: string, callback?: ListUpdateCallback<T>, filter?: (item: T) => boolean): { unsubscribe: Unsubscribe, data: T[] } {
        const subscribers = this.genericDataListSubscribers[typeName] || [];
        let filteredCallback = callback;
        if (filteredCallback && callback) {
            if (filter) {
                filteredCallback = (data, { entered, left, updated }) => {
                    data = data.filter(filter);
                    callback(data, { entered, left, updated });
                }
            }
            subscribers.push(filteredCallback);
        }
        this.genericDataListSubscribers[typeName] = subscribers;
        let currentData = this.genericData[typeName]?.values() || [];
        if (filter) {
            return {
                unsubscribe: () => {
                    this.genericDataListSubscribers[typeName] = this.genericDataListSubscribers[typeName]?.filter(cb => cb !== callback) || [];
                }, data: (Array.from(currentData) as T[]).filter(filter)
            };
        }
        return {
            unsubscribe: () => {
                this.genericDataListSubscribers[typeName] = this.genericDataListSubscribers[typeName]?.filter(cb => cb !== callback) || [];
            }, data: Array.from(currentData) as T[]
        };
    }
    getValueWithSubscription<T>(typeName: string, id: number | ((item: T) => boolean), callback?: ItemUpdateCallback<T>): { unsubscribe: Unsubscribe, data: T | undefined } {
        if (!this.genericDataTypeToId[typeName]) {
            throw new Error(`No id getter for type ${typeName}`);
        }
        if (typeof id === "function") {
            const relevantIds = Array.from(this.genericData[typeName]?.keys() || []).filter(_id => id(this.genericData[typeName]?.get(_id)!));
            if (relevantIds.length == 0) {
                return {
                    unsubscribe: () => { },
                    data: undefined
                };
            } else if (relevantIds.length == 1) {
                const id = relevantIds[0];
                const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
                if (callback) {
                    this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback]);
                }
                return {
                    unsubscribe: () => {
                        this.genericDataSubscribers[typeName]?.set(id, subscribers.filter(cb => cb !== callback));
                    }, data: this.genericData[typeName]?.get(id) as T | undefined
                };
            } else {
                throw new Error(`Multiple ids found for type ${typeName}`);
            }
        } else if (typeof id === "number") {
            const subscribers = this.genericDataSubscribers[typeName]?.get(id) || [];
            if (callback) {
                this.genericDataSubscribers[typeName]?.set(id, [...subscribers, callback]);
            }
            return {
                unsubscribe: () => {
                    this.genericDataSubscribers[typeName]?.set(id, subscribers.filter(cb => cb !== callback));
                }, data: this.genericData[typeName]?.get(id) as T | undefined
            };
        } else {
            throw new Error(`Invalid id type ${typeof id}`);
        }
    }
    handleGenericDataEvent(typeName: string, event: LiveEvent) {
        const body = event.payload;
        const idGetter = this.genericDataTypeToId[typeName];
        const id = idGetter(body);
        if (event.type === "created") {
            this.genericData[typeName].set(id, body);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach(cb => cb(body));
            this.genericDataListSubscribers[typeName]?.forEach(cb => cb(Array.from(this.genericData[typeName].values()), { entered: [body], left: [], updated: [] }));
        }
        else if (event.type === "updated") {
            this.genericData[typeName].set(id, body);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach(cb => cb(body));
            this.genericDataListSubscribers[typeName]?.forEach(cb => cb(Array.from(this.genericData[typeName].values()), { entered: [], left: [], updated: [body] }));
        }
        else if (event.type === "deleted") {
            this.genericData[typeName].delete(id);
            this.genericDataSubscribers[typeName]?.get(id)?.forEach(cb => cb(undefined));
            this.genericDataListSubscribers[typeName]?.forEach(cb => cb(Array.from(this.genericData[typeName].values()), { entered: [], left: [body], updated: [] }));
        }
    }
    constructor() {
    }

    get isReady() {
        return this._submission !== undefined;
    }

    set submission(submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric) {
        this._submission = submission;
    }

    set file(file: SubmissionFile | undefined) {
        this._file = file;
    }
    get submission() {
        if (!this._submission) {
            throw new Error("Submission not set, must wait for isReady to be true");
        }
        return this._submission;
    }
    get file() {
        return this._file;
    }
}

type SubmissionContextType = {
    submissionController: SubmissionController;
}

const SubmissionContext = createContext<SubmissionContextType | null>(null);

export function SubmissionProvider({ submission_id, children }: { submission_id?: number, children: React.ReactNode }) {
    if (!submission_id) {
        submission_id = Number(useParams().submissions_id);
    }
    const controller = useRef<SubmissionController>(new SubmissionController());
    const [ready, setReady] = useState(false);

    return <SubmissionContext.Provider value={{ submissionController: controller.current }}>
        <SubmissionControllerCreator submission_id={submission_id} setReady={setReady} />
        {ready && children}
    </SubmissionContext.Provider>
}
export function useSubmissionFileComments({ file_id, onEnter, onLeave, onUpdate, onJumpTo }: { file_id?: number, onEnter?: (comment: SubmissionFileComment[]) => void, onLeave?: (comment: SubmissionFileComment[]) => void, onUpdate?: (comment: SubmissionFileComment[]) => void, onJumpTo?: (comment: SubmissionFileComment) => void }) {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        return [];
    }
    const submissionController = ctx.submissionController;
    const [comments, setComments] = useState<SubmissionFileComment[]>([]);
    useEffect(() => {
        const { unsubscribe, data } = submissionController.listGenericData<SubmissionFileComment>("submission_file_comments", (data, { entered, left, updated }) => {
            setComments(data.filter((comment) => comment.deleted_at === null));
            if (onEnter) {
                onEnter(entered.filter((comment) => comment.deleted_at === null));
            }
            if (onLeave) {
                onLeave(left.filter((comment) => comment.deleted_at === null));
            }
            if (onUpdate) {
                onUpdate(updated.filter((comment) => comment.deleted_at === null));
            }
        }, (item) => file_id === undefined || item.submission_file_id === file_id);
        setComments(data.filter((comment) => comment.deleted_at === null));
        if (onEnter) {
            onEnter(data.filter((comment) => comment.deleted_at === null));
        }
        return () => unsubscribe();
    }, [submissionController, file_id]);
    return comments;
}

export function useSubmissionComments({ onEnter, onLeave, onUpdate, onJumpTo }: { onEnter?: (comment: SubmissionComments[]) => void, onLeave?: (comment: SubmissionComments[]) => void, onUpdate?: (comment: SubmissionComments[]) => void, onJumpTo?: (comment: SubmissionComments) => void }) {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        return [];
    }
    const submissionController = ctx.submissionController;
    const [comments, setComments] = useState<SubmissionComments[]>([]);
    useEffect(() => {
        const { unsubscribe, data } = submissionController.listGenericData<SubmissionComments>("submission_comments", (data, { entered, left, updated }) => {
            setComments(data.filter((comment) => comment.deleted_at === null));
            if (onEnter) {
                onEnter(entered.filter((comment) => comment.deleted_at === null));
            }
            if (onLeave) {
                onLeave(left.filter((comment) => comment.deleted_at === null));
            }
            if (onUpdate) {
                onUpdate(updated.filter((comment) => comment.deleted_at === null));
            }
        });
        setComments(data.filter((comment) => comment.deleted_at === null));
        if (onEnter) {
            onEnter(data.filter((comment) => comment.deleted_at === null));
        }
        return () => unsubscribe();
    }, [submissionController]);
    return comments;
}

function SubmissionControllerCreator({ submission_id, setReady }: { submission_id: number, setReady: (ready: boolean) => void }) {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        throw new Error("SubmissionContext not found");
    }
    const submissionController = ctx.submissionController;
    const { query } = useShow<SubmissionWithFilesGraderResultsOutputTestsAndRubric>({
        resource: "submissions",
        id: submission_id,
        meta: {
            select: "*, assignments(*, rubrics(*,rubric_criteria(*,rubric_checks(*)))), submission_files(*), assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*))), grader_results(*, grader_result_tests(*), grader_result_output(*))"
        }
    });
    const { data: liveFileComments, isLoading: liveFileCommentsLoading } = useList<SubmissionFileComment>({
        resource: "submission_file_comments",
        filters: [
            { field: "submission_id", operator: "eq", value: submission_id }
        ],
        liveMode: "manual",
        pagination: {
            pageSize: 1000
        },
        onLiveEvent: (event) => {
            submissionController.handleGenericDataEvent("submission_file_comments", event);
        }
    });
    const { data: liveReviews, isLoading: liveReviewsLoading } = useList<SubmissionReviewWithRubric>({
        resource: "submission_reviews",
        meta: {
            select: "*, rubrics(*, rubric_criteria(*, rubric_checks(*)))"
        },
        filters: [
            { field: "submission_id", operator: "eq", value: submission_id }
        ],
        liveMode: "manual",
        pagination: {
            pageSize: 1000
        },
        onLiveEvent: (event) => {
            submissionController.handleGenericDataEvent("submission_reviews", event);
        }
    });
    const { data: liveComments, isLoading: liveCommentsLoading } = useList<SubmissionComments>({
        resource: "submission_comments",
        filters: [
            { field: "submission_id", operator: "eq", value: submission_id }
        ],
        liveMode: "manual",
        pagination: {
            pageSize: 1000
        },
        onLiveEvent: (event) => {
            submissionController.handleGenericDataEvent("submission_comments", event);
        }
    });
    const anyIsLoading = liveFileCommentsLoading || liveReviewsLoading || liveCommentsLoading || query.isLoading;
    useEffect(() => {
        if (query.data?.data) {
            submissionController.submission = query.data.data;
        }
    }, [submissionController, query.data])
    useEffect(() => {
        if (!anyIsLoading) {
            setReady(true);
        }
    }, [anyIsLoading]);
    submissionController.registerGenericDataType("submission_file_comments", (item: SubmissionFileComment) => item.id);
    useEffect(() => {
        if (liveFileComments?.data) {
            submissionController.setGeneric("submission_file_comments", liveFileComments.data);
        }
    }, [submissionController, anyIsLoading]);
    submissionController.registerGenericDataType("submission_comments", (item: SubmissionComments) => item.id);
    useEffect(() => {
        if (liveComments?.data) {
            submissionController.setGeneric("submission_comments", liveComments.data);
        }
    }, [submissionController, anyIsLoading]);
    submissionController.registerGenericDataType("submission_reviews", (item: SubmissionReviewWithRubric) => item.id);
    useEffect(() => {
        if (liveReviews?.data) {
            submissionController.setGeneric("submission_reviews", liveReviews.data);
        }
    }, [submissionController, anyIsLoading]);
    if (query.isLoading || !liveFileComments?.data) {
        return (
            <div style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: 'rgba(255, 255, 255, 0.8)',
                zIndex: 9999
            }}>
                <Spinner />
                <Text>Loading submission...</Text>
            </div>
        );
    }
    if (query.error) {
        toaster.error({
            title: "Error loading submission",
            description: query.error.message
        })
    }
    if (!query.data) {
        return <></>;
    }
    return <></>;
}
export function useSubmission() {
    const controller = useSubmissionController();
    return controller.submission;
}
export function useAllRubricCheckInstances(review_id: number | undefined) {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        return [];
    }
    const fileComments = useSubmissionFileComments({});
    const submissionComments = useSubmissionComments({});
    if (!review_id) {
        return [];
    }
    const comments = [...fileComments, ...submissionComments];
    return comments.filter((c) => c.submission_review_id === review_id);
}
export function useRubricCheckInstances(check: RubricChecks, review_id: number | undefined) {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        return [];
    }
    const fileComments = useSubmissionFileComments({});
    const submissionComments = useSubmissionComments({});
    if (!review_id) {
        return [];
    }
    const comments = [...fileComments, ...submissionComments];
    return comments.filter((c) => check.id === c.rubric_check_id && c.submission_review_id === review_id);
}
export function useSubmissionRubric() {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        return undefined;
    }
    return ctx.submissionController.submission.assignments.rubrics;
}
export function useRubricCriteriaInstances(
    { criteria, review_id, rubric_id }: {
        criteria?: RubricCriteriaWithRubricChecks,
        review_id?: number,
        rubric_id?: number,
    }) {
    const fileComments = useSubmissionFileComments({});
    const submissionComments = useSubmissionComments({});
    const review = useSubmissionReview(review_id);
    const rubric = useSubmissionRubric();
    if (!review_id) {
        return [];
    }
    const comments = [...fileComments, ...submissionComments];
    if (criteria) {
        return comments.filter((eachComment) =>
            eachComment.submission_review_id === review_id
            &&
            criteria.rubric_checks.find((eachCheck) => eachCheck.id === eachComment.rubric_check_id));
    }
    if (rubric_id) {
        const allCriteria = rubric?.rubric_criteria || [];
        const allChecks = allCriteria.flatMap((eachCriteria) => eachCriteria.rubric_checks || []);
        return comments.filter((eachComment) =>
            eachComment.submission_review_id === review_id
            &&
            allChecks.find((eachCheck) => eachCheck.id === eachComment.rubric_check_id)
        );
    }
    throw new Error("Either criteria or rubric_id must be provided");
}
export function useSubmissionReview(reviewId?: number | null) {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        return undefined;
    }
    const controller = ctx.submissionController;
    const [review, setReview] = useState<SubmissionReview | undefined>(undefined);
    if (!reviewId) {
        reviewId = controller.submission.grading_review_id;
        if (!reviewId) {
            throw new Error("No review found for this submission");
        }
    }
    useEffect(() => {
        const { unsubscribe, data } = controller.getValueWithSubscription<SubmissionReview>("submission_reviews", reviewId, (data) => {
            setReview(data);
        });
        setReview(data);
        return () => unsubscribe();
    }, [controller, reviewId]);
    return review;
}
export function useRubricCheck(rubric_check_id: number | null) {
    if (!rubric_check_id) {
        return {
            rubricCheck: undefined,
            rubricCriteria: undefined
        }
    }
    const controller = useSubmissionController();
    const criteria = controller.submission.assignments.rubrics?.rubric_criteria?.find((c) => c.rubric_checks?.some((c) => c.id === rubric_check_id));
    const check = criteria?.rubric_checks?.find((c) => c.id === rubric_check_id);
    return {
        rubricCheck: check,
        rubricCriteria: criteria
    }
}

export function useSubmissionFile() {
    const controller = useSubmissionController();
    return controller.file;
}

export function useSubmissionController(): SubmissionController {
    const ctx = useContext(SubmissionContext);
    if (!ctx) {
        throw new Error("SubmissionContext not found");
    }
    return ctx.submissionController;
}


