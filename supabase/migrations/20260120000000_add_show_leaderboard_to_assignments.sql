ALTER TABLE public.assignments 
ADD COLUMN show_leaderboard boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.assignments.show_leaderboard IS 'When true, displays the autograder score leaderboard to students on the assignment page';
