-- #1292: the printed words on each template page, so the exam worker can line a scan up with it
-- before reading any region. Same shape as exam_scan_pages.ocr_data: { words: [{ text, x, y,
-- width, height }] }, normalized to the page.
--
-- The worker fills it the first time it matches a batch for the exam. A re-uploaded template gets
-- new rows (uploadTemplatePages deletes and re-inserts), so the new pages are read again.
alter table public.exam_template_pages add column if not exists ocr_data jsonb;
