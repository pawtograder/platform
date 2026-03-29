-- Remove internal helper if a prior revision of 20260329000000 created it (dev DBs only).
DROP FUNCTION IF EXISTS public._materialize_null_gradebook_column_sort_orders(bigint);
