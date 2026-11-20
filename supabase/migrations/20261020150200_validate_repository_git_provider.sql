-- Validate with SHARE UPDATE EXCLUSIVE, allowing normal reads and writes during the scan.
ALTER TABLE public.repositories VALIDATE CONSTRAINT repositories_git_provider_check;
