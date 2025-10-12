import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallback } from "react";
import TableController, { useListTableControllerValues } from "../../lib/TableController";

// eslint-disable-file @typescript-eslint/no-explicit-any

// Mock Supabase client
jest.mock("@supabase/supabase-js");

type TestRow = {
  id: number;
  name: string;
  category: string;
  created_at: string;
};

describe("useListTableControllerValues", () => {
  let mockClient: any;
  let controller: TableController<any, "*", number, TestRow>;

  beforeEach(() => {
    // Create a mock Supabase client
    mockClient = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({
        data: [
          { id: 1, name: "Item 1", category: "A", created_at: new Date().toISOString() },
          { id: 2, name: "Item 2", category: "B", created_at: new Date().toISOString() },
          { id: 3, name: "Item 3", category: "A", created_at: new Date().toISOString() }
        ],
        error: null
      })
    };

    // Create a real TableController instance
    controller = new TableController({
      query: mockClient.from("test_table").select("*"),
      client: mockClient,
      table: "test_table" as any,
      debounceInterval: 0 // No debounce for testing
    });
  });

  afterEach(() => {
    controller.close();
    jest.clearAllMocks();
  });

  it("should subscribe to the list and return matching items", async () => {
    // Wait for controller to be ready
    await controller.readyPromise;

    const { result } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });

    // Wait for the hook to process data
    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    expect(result.current).toHaveLength(2);
    expect(result.current?.[0].category).toBe("A");
    expect(result.current?.[1].category).toBe("A");
  });

  it("should update when a new matching row is added", async () => {
    await controller.readyPromise;

    const { result } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });

    // Wait for initial data
    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    // Add a new row that matches the predicate
    await act(async () => {
      // Simulate adding a row through the controller
      const newRow = { id: 4, name: "Item 4", category: "A", created_at: new Date().toISOString() };

      // Mock the insert response
      mockClient.from.mockReturnThis();
      mockClient.select.mockReturnThis();
      mockClient.insert = jest.fn().mockReturnThis();
      mockClient.single = jest.fn().mockResolvedValue({
        data: newRow,
        error: null
      });

      await controller.create({ name: "Item 4", category: "A" } as any);
    });

    // Should now have 3 matching items
    await waitFor(() => {
      expect(result.current?.length).toBe(3);
    });

    expect(result.current?.some((item) => item.id === 4)).toBe(true);
  });

  it("should not update when a non-matching row is added", async () => {
    await controller.readyPromise;

    const { result } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });

    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    const initialLength = result.current?.length || 0;

    // Add a row that doesn't match
    await act(async () => {
      const newRow = { id: 5, name: "Item 5", category: "C", created_at: new Date().toISOString() };

      mockClient.insert = jest.fn().mockReturnThis();
      mockClient.single = jest.fn().mockResolvedValue({
        data: newRow,
        error: null
      });

      await controller.create({ name: "Item 5", category: "C" } as any);
    });

    // Should still have the same number of matching items
    expect(result.current?.length).toBe(initialLength);
    expect(result.current?.some((item) => item.id === 5)).toBe(false);
  });

  it("should handle multiple components with different predicates", async () => {
    await controller.readyPromise;

    const { result: resultA } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });
    const { result: resultB } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "B", []);
      return useListTableControllerValues(controller, predicate);
    });

    await waitFor(() => {
      expect(resultA.current?.length).toBe(2);
      expect(resultB.current?.length).toBe(1);
    });

    expect(resultA.current?.every((item) => item.category === "A")).toBe(true);
    expect(resultB.current?.every((item) => item.category === "B")).toBe(true);
  });

  it("should maintain subscription when predicate changes", async () => {
    await controller.readyPromise;

    let category = "A";
    const { result, rerender } = renderHook(() =>
      //eslint-disable-next-line react-hooks/exhaustive-deps
      useListTableControllerValues(
        controller,
        useCallback((row: TestRow) => row.category === category, [category])
      )
    );

    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    // Change the predicate
    act(() => {
      category = "B";
      rerender();
    });

    await waitFor(() => {
      expect(result.current?.length).toBe(1);
    });

    expect(result.current?.[0].category).toBe("B");
  });

  it("should receive broadcasts and update accordingly", async () => {
    await controller.readyPromise;

    const { result } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });

    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    // Simulate a broadcast by directly calling the private method (for testing)
    await act(async () => {
      const newRow = {
        id: 6,
        name: "Item 6",
        category: "A",
        created_at: new Date().toISOString(),
        __db_pending: false
      };

      // Access private method for testing
      (controller as any)._addRow(newRow);
    });

    // Should receive the broadcast update
    await waitFor(() => {
      expect(result.current?.length).toBe(3);
    });

    expect(result.current?.some((item) => item.id === 6)).toBe(true);
  });

  it("should not lose subscription during rapid re-renders", async () => {
    await controller.readyPromise;

    let renderCount = 0;
    const { result, rerender } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => {
        renderCount++;
        return row.category === "A";
      }, []);
      return useListTableControllerValues(controller, predicate);
    });

    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    // Trigger multiple rapid re-renders
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        rerender();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    // Add a row during/after re-renders
    await act(async () => {
      const newRow = {
        id: 7,
        name: "Item 7",
        category: "A",
        created_at: new Date().toISOString(),
        __db_pending: false
      };

      (controller as any)._addRow(newRow);
    });

    // Should still receive updates
    await waitFor(() => {
      expect(result.current?.length).toBe(3);
    });
  });

  it("should properly clean up subscriptions on unmount", async () => {
    await controller.readyPromise;

    const { result, unmount } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });

    await waitFor(() => {
      expect(result.current?.length).toBe(2);
    });

    const listenerCountBefore = (controller as any)._listDataListeners.length;
    expect(listenerCountBefore).toBeGreaterThan(0);

    // Unmount the hook
    unmount();

    // Listeners should be cleaned up
    const listenerCountAfter = (controller as any)._listDataListeners.length;
    expect(listenerCountAfter).toBeLessThan(listenerCountBefore);
  });

  it("PRODUCTION SCENARIO: should receive broadcasts when multiple components subscribe with different predicates", async () => {
    await controller.readyPromise;

    // Simulate multiple components filtering by category (like different rubric_check_id values)
    // Each component sees all items in their category
    const { result: resultA } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "A", []);
      return useListTableControllerValues(controller, predicate);
    });

    const { result: resultB } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "B", []);
      return useListTableControllerValues(controller, predicate);
    });

    // Wait for all hooks to initialize
    await waitFor(() => {
      expect(resultA.current?.length).toBe(2); // Items 1 and 3 are category A
      expect(resultB.current?.length).toBe(1); // Item 2 is category B
    });

    // Verify there are active listeners
    const listenerCount = (controller as any)._listDataListeners.length;
    console.log(`Active listeners before broadcast: ${listenerCount}`);
    expect(listenerCount).toBeGreaterThan(0);

    // NOW THE CRITICAL PART: Simulate a realtime broadcast
    // This is what was failing in production - broadcasts arriving when there were 0 listeners
    await act(async () => {
      const newRow = {
        id: 4,
        name: "Item 4",
        category: "A",
        created_at: new Date().toISOString(),
        __db_pending: false
      };

      // Check listener count at the moment of broadcast
      const listenersAtBroadcast = (controller as any)._listDataListeners.length;
      console.log(`Listeners at broadcast time: ${listenersAtBroadcast}`);

      // This should NOT be 0!
      expect(listenersAtBroadcast).toBeGreaterThan(0);

      // Simulate the broadcast
      (controller as any)._addRow(newRow);
    });

    // The broadcast should have been received by resultA (category A)
    await waitFor(() => {
      expect(resultA.current?.length).toBe(3); // Should now have items 1, 3, and 4
      expect(resultA.current?.some((item) => item.id === 4)).toBe(true);
      expect(resultB.current?.length).toBe(1); // Should still only have item 2
    });
  });

  it("PRODUCTION SCENARIO: should maintain listeners during predicate changes from multiple components", async () => {
    await controller.readyPromise;

    // Component 1 with changing predicate (simulates rubric_check_id changing)
    let category1 = "A";
    const { result: result1, rerender: rerender1 } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === category1, [category1]);
      return useListTableControllerValues(controller, predicate);
    });

    // Component 2 with different predicate
    const { result: result2 } = renderHook(() => {
      const predicate = useCallback((row: TestRow) => row.category === "B", []);
      return useListTableControllerValues(controller, predicate);
    });

    await waitFor(() => {
      expect(result1.current?.length).toBe(2);
      expect(result2.current?.length).toBe(1);
    });

    // Change predicate in component 1 (like when rubric_check_id changes)
    act(() => {
      category1 = "B";
      rerender1();
    });

    await waitFor(() => {
      expect(result1.current?.length).toBe(1);
    });

    // NOW broadcast while predicates are changing
    await act(async () => {
      const listenersBeforeBroadcast = (controller as any)._listDataListeners.length;
      console.log(`Listeners during predicate change: ${listenersBeforeBroadcast}`);

      // CRITICAL: Should still have listeners even during re-renders
      expect(listenersBeforeBroadcast).toBeGreaterThan(0);

      const newRow = {
        id: 5,
        name: "Item 5",
        category: "B",
        created_at: new Date().toISOString(),
        __db_pending: false
      };

      (controller as any)._addRow(newRow);
    });

    // Both components should receive the update
    await waitFor(() => {
      const allItems = [...(result1.current || []), ...(result2.current || [])];
      expect(allItems.some((item) => item.id === 5)).toBe(true);
    });
  });
});
