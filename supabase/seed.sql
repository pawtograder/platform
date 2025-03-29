INSERT into public.classes(name, semester, slug, is_demo, github_org) VALUES ('Demo Class', 20281, 'demo-class', true, 'autograder-dev');
insert into help_queues (name, description, class_id, available, depth)
  VALUES ('demo','demo description', 1, TRUE, 0);