INSERT into public.classes(id,name, semester, slug, is_demo, github_org, time_zone) VALUES (1, 'Demo Class', 20281, 'demo-class', true, 'autograder-dev', 'America/New_York');

DO $$
DECLARE 
    assignment_id int8;
    assignment_self_review_settings_id int8;
    new_self_review_rubric_id int8;
    new_grading_review_rubric_id int8;
    self_review_criteria_id int8;
    grading_review_criteria_id int8;
    self_review_check_reference_id int8;
    grading_review_check_reference_id int8;
BEGIN
INSERT INTO public.assignment_self_review_settings(enabled, deadline_offset, allow_early, class_id)
  VALUES (true, 2, true, 1) RETURNING id into assignment_self_review_settings_id;
    
INSERT INTO public.assignments (
  class_id,
  due_date,
  group_config,
  has_autograder,
  has_handgrader,
  max_late_tokens,
  title,
  description,
  slug,
  release_date,
  total_points,
  template_repo,
  self_review_setting_id
) VALUES (
  1,
  '2028-12-31T23:59:59Z',
  'individual',
  TRUE,
  TRUE,
  3,
  'Demo Assignment',
  'This is a demo assignment for testing.',
  'demo-assignment',
  '2024-12-01T00:00:00Z',
  100,
  'not-actually/a-template-repo',
  assignment_self_review_settings_id
) RETURNING id into assignment_id;

-- Retrieve the self review and grading review rubric IDs
SELECT self_review_rubric_id INTO new_self_review_rubric_id FROM public.assignments WHERE id = assignment_id;
SELECT grading_rubric_id INTO new_grading_review_rubric_id FROM public.assignments WHERE id = assignment_id;

INSERT INTO public.rubric_parts (
  class_id,
  name,
  description,
  ordinal,
  rubric_id
) VALUES (
  1,
  'Self Review',
  'Self review rubric',
  0,
  new_self_review_rubric_id
), (
  1,
  'Grading Review',
  'Grading review rubric',
  1,
  new_grading_review_rubric_id
) ;

-- Insert 1 new rubric criteria for self review rubric
INSERT INTO public.rubric_criteria (
  rubric_id,
  name,
  description,
  total_points,
  is_additive,
  class_id,
  ordinal,
  rubric_part_id
) VALUES (
  new_self_review_rubric_id,
  'Self Review Criteria',
  'Criteria for self review evaluation',
  10,
  true,
  1,
  0,
  (SELECT id FROM public.rubric_parts WHERE rubric_id = new_self_review_rubric_id LIMIT 1)
) RETURNING id INTO self_review_criteria_id;

-- Insert 1 new rubric criteria for grading review rubric
INSERT INTO public.rubric_criteria (
  rubric_id,
  name,
  description,
  total_points,
  is_additive,
  class_id,
  ordinal,
  rubric_part_id
) VALUES (
  new_grading_review_rubric_id,
  'Grading Review Criteria',
  'Criteria for grading review evaluation',
  20,
  true,
  1,
  0,
  (SELECT id FROM public.rubric_parts WHERE rubric_id = new_grading_review_rubric_id LIMIT 1)
) RETURNING id INTO grading_review_criteria_id;

-- Insert 2 new rubric checks for self review criteria
INSERT INTO public.rubric_checks (
  rubric_criteria_id,
  name,
  description,
  ordinal,
  points,
  is_annotation,
  is_comment_required,
  class_id,
  is_required
) VALUES 
  (self_review_criteria_id, 'Self Review Check 1', 'First check for self review', 0, 5, true, false, 1, true) RETURNING id INTO self_review_check_reference_id;
INSERT INTO public.rubric_checks (
  rubric_criteria_id,
  name,
  description,
  ordinal,
  points,
  is_annotation,
  is_comment_required,
  class_id,
  is_required
) VALUES 

  (self_review_criteria_id, 'Self Review Check 2', 'Second check for self review', 1, 5, false, false, 1, true); 

-- Insert 2 new rubric checks for grading review criteria
INSERT INTO public.rubric_checks (
  rubric_criteria_id,
  name,
  description,
  ordinal,
  points,
  is_annotation,
  is_comment_required,
  class_id,
  is_required
) VALUES 
  (grading_review_criteria_id, 'Grading Review Check 1', 'First check for grading review', 0, 10, true, false, 1, true)
RETURNING id INTO grading_review_check_reference_id;

INSERT INTO public.rubric_checks (
  rubric_criteria_id,
  name,
  description,
  ordinal,
  points,
  is_annotation,
  is_comment_required,
  class_id,
  is_required
) VALUES 
  (grading_review_criteria_id, 'Grading Review Check 2', 'Second check for grading review', 1, 10, false, false, 1, true);

insert into rubric_check_references(referencing_rubric_check_id, referenced_rubric_check_id, class_id) values
(grading_review_check_reference_id, self_review_check_reference_id, 1);
END $$;

insert into help_queues (name, description, class_id, available, depth)
  VALUES ('demo','demo description', 1, TRUE, 0);

INSERT INTO "public"."name_generation_words" ("id", "word", "is_noun", "is_adjective") VALUES ('1', 'able', 'false', 'true'), ('2', 'action', 'false', 'true'), ('3', 'active', 'false', 'true'), ('4', 'actual', 'false', 'true'), ('5', 'adept', 'false', 'true'), ('6', 'adored', 'false', 'true'), ('7', 'adroit', 'false', 'true'), ('8', 'affectionate', 'false', 'true'), ('9', 'agile', 'false', 'true'), ('10', 'airy', 'false', 'true'), ('11', 'alert', 'false', 'true'), ('12', 'alive', 'false', 'true'), ('13', 'alter', 'false', 'true'), ('14', 'amiable', 'false', 'true'), ('15', 'ample', 'false', 'true'), ('16', 'and', 'false', 'true'), ('17', 'anima', 'false', 'true'), ('18', 'apt', 'false', 'true'), ('19', 'ardent', 'false', 'true'), ('20', 'are', 'false', 'true'), ('21', 'astute', 'false', 'true'), ('22', 'august', 'false', 'true'), ('23', 'avid', 'false', 'true'), ('24', 'awake', 'false', 'true'), ('25', 'aware', 'false', 'true'), ('26', 'balmy', 'false', 'true'), ('27', 'benevolent', 'false', 'true'), ('28', 'big', 'false', 'true'), ('29', 'billowing', 'false', 'true'), ('30', 'blessed', 'false', 'true'), ('31', 'bold', 'false', 'true'), ('32', 'boss', 'false', 'true'), ('33', 'brainy', 'false', 'true'), ('34', 'brave', 'false', 'true'), ('35', 'brawny', 'false', 'true'), ('36', 'breezy', 'false', 'true'), ('37', 'brief', 'false', 'true'), ('38', 'bright', 'false', 'true'), ('39', 'brisk', 'false', 'true'), ('40', 'busy', 'false', 'true'), ('41', 'calm', 'false', 'true'), ('42', 'can', 'false', 'true'), ('43', 'canny', 'false', 'true'), ('44', 'cared', 'false', 'true'), ('45', 'caring', 'false', 'true'), ('46', 'casual', 'false', 'true'), ('47', 'celestial', 'false', 'true'), ('48', 'charming', 'false', 'true'), ('49', 'chic', 'false', 'true'), ('50', 'chief', 'false', 'true'), ('51', 'choice', 'false', 'true'), ('52', 'chosen', 'false', 'true'), ('53', 'chummy', 'false', 'true'), ('54', 'civic', 'false', 'true'), ('55', 'civil', 'false', 'true'), ('56', 'classy', 'false', 'true'), ('57', 'clean', 'false', 'true'), ('58', 'clear', 'false', 'true'), ('59', 'clever', 'false', 'true'), ('60', 'close', 'false', 'true'), ('61', 'cogent', 'false', 'true'), ('62', 'composed', 'false', 'true'), ('63', 'cool', 'false', 'true'), ('64', 'cosmic', 'false', 'true'), ('65', 'cozy', 'false', 'true'), ('66', 'cuddly', 'false', 'true'), ('67', 'cute', 'false', 'true'), ('68', 'dainty', 'false', 'true'), ('69', 'dandy', 'false', 'true'), ('70', 'dapper', 'false', 'true'), ('71', 'daring', 'false', 'true'), ('72', 'dear', 'false', 'true'), ('73', 'decent', 'false', 'true'), ('74', 'deep', 'false', 'true'), ('75', 'deft', 'false', 'true'), ('76', 'deluxe', 'false', 'true'), ('77', 'devout', 'false', 'true'), ('78', 'direct', 'false', 'true'), ('79', 'divine', 'false', 'true'), ('80', 'doted', 'false', 'true'), ('81', 'doting', 'false', 'true'), ('82', 'dreamy', 'false', 'true'), ('83', 'driven', 'false', 'true'), ('84', 'dry', 'false', 'true'), ('85', 'earthy', 'false', 'true'), ('86', 'easy', 'false', 'true'), ('87', 'elated', 'false', 'true'), ('88', 'energized', 'false', 'true'), ('89', 'enigmatic', 'false', 'true'), ('90', 'equal', 'false', 'true'), ('91', 'exact', 'false', 'true'), ('92', 'exotic', 'false', 'true'), ('93', 'expert', 'false', 'true'), ('94', 'exuberant', 'false', 'true'), ('95', 'fair', 'false', 'true'), ('96', 'famed', 'false', 'true'), ('97', 'famous', 'false', 'true'), ('98', 'fancy', 'false', 'true'), ('99', 'fast', 'false', 'true'), ('100', 'fiery', 'false', 'true'), ('101', 'fine', 'false', 'true'), ('102', 'fit', 'false', 'true'), ('103', 'flashy', 'false', 'true'), ('104', 'fleek', 'false', 'true'), ('105', 'fleet', 'false', 'true'), ('106', 'flowing', 'false', 'true'), ('107', 'fluent', 'false', 'true'), ('108', 'fluffy', 'false', 'true'), ('109', 'fluttering', 'false', 'true'), ('110', 'flying', 'false', 'true'), ('111', 'fond', 'false', 'true'), ('112', 'frank', 'false', 'true'), ('113', 'free', 'false', 'true'), ('114', 'fresh', 'false', 'true'), ('115', 'full', 'false', 'true'), ('116', 'fun', 'false', 'true'), ('117', 'funny', 'false', 'true'), ('118', 'fuscia', 'false', 'true'), ('119', 'genial', 'false', 'true'), ('120', 'gentle', 'false', 'true'), ('121', 'giddy', 'false', 'true'), ('122', 'gifted', 'false', 'true'), ('123', 'giving', 'false', 'true'), ('124', 'glad', 'false', 'true'), ('125', 'gnarly', 'false', 'true'), ('126', 'gold', 'false', 'true'), ('127', 'golden', 'false', 'true'), ('128', 'good', 'false', 'true'), ('129', 'goodly', 'false', 'true'), ('130', 'graceful', 'false', 'true'), ('131', 'grand', 'false', 'true'), ('132', 'great', 'false', 'true'), ('133', 'green', 'false', 'true'), ('134', 'groovy', 'false', 'true'), ('135', 'guided', 'false', 'true'), ('136', 'gutsy', 'false', 'true'), ('137', 'haloed', 'false', 'true'), ('138', 'happy', 'false', 'true'), ('139', 'hardy', 'false', 'true'), ('140', 'harmonious', 'false', 'true'), ('141', 'hearty', 'false', 'true'), ('142', 'heroic', 'false', 'true'), ('143', 'high', 'false', 'true'), ('144', 'hip', 'false', 'true'), ('145', 'hollow', 'false', 'true'), ('146', 'holy', 'false', 'true'), ('147', 'honest', 'false', 'true'), ('148', 'huge', 'false', 'true'), ('149', 'humane', 'false', 'true'), ('150', 'humble', 'false', 'true'), ('151', 'hunky', 'false', 'true'), ('152', 'icy', 'false', 'true'), ('153', 'ideal', 'false', 'true'), ('154', 'immune', 'false', 'true'), ('155', 'indigo', 'false', 'true'), ('156', 'inquisitive', 'false', 'true'), ('157', 'jazzed', 'false', 'true'), ('158', 'jazzy', 'false', 'true'), ('159', 'jolly', 'false', 'true'), ('160', 'jovial', 'false', 'true'), ('161', 'joyful', 'false', 'true'), ('162', 'joyous', 'false', 'true'), ('163', 'jubilant', 'false', 'true'), ('164', 'juicy', 'false', 'true'), ('165', 'just', 'false', 'true'), ('166', 'keen', 'false', 'true'), ('167', 'khaki', 'false', 'true'), ('168', 'kind', 'false', 'true'), ('169', 'kingly', 'false', 'true'), ('170', 'large', 'false', 'true'), ('171', 'lavish', 'false', 'true'), ('172', 'lawful', 'false', 'true'), ('173', 'left', 'false', 'true'), ('174', 'legal', 'false', 'true'), ('175', 'legit', 'false', 'true'), ('176', 'light', 'false', 'true'), ('177', 'like', 'false', 'true'), ('178', 'liked', 'false', 'true'), ('179', 'likely', 'false', 'true'), ('180', 'limber', 'false', 'true'), ('181', 'limitless', 'false', 'true'), ('182', 'lively', 'false', 'true'), ('183', 'loved', 'false', 'true'), ('184', 'lovely', 'false', 'true'), ('185', 'loyal', 'false', 'true'), ('186', 'lucid', 'false', 'true'), ('187', 'lucky', 'false', 'true'), ('188', 'lush', 'false', 'true'), ('189', 'main', 'false', 'true'), ('190', 'major', 'false', 'true'), ('191', 'master', 'false', 'true'), ('192', 'mature', 'false', 'true'), ('193', 'max', 'false', 'true'), ('194', 'maxed', 'false', 'true'), ('195', 'mellow', 'false', 'true'), ('196', 'merciful', 'false', 'true'), ('197', 'merry', 'false', 'true'), ('198', 'mighty', 'false', 'true'), ('199', 'mint', 'false', 'true'), ('200', 'mirthful', 'false', 'true'), ('201', 'modern', 'false', 'true'), ('202', 'modest', 'false', 'true'), ('203', 'money', 'false', 'true'), ('204', 'moonlit', 'false', 'true'), ('205', 'moral', 'false', 'true'), ('206', 'moving', 'false', 'true'), ('207', 'mucho', 'false', 'true'), ('208', 'mutual', 'false', 'true'), ('209', 'mysterious', 'false', 'true'), ('210', 'native', 'false', 'true'), ('211', 'natural', 'false', 'true'), ('212', 'near', 'false', 'true'), ('213', 'neat', 'false', 'true'), ('214', 'needed', 'false', 'true'), ('215', 'new', 'false', 'true'), ('216', 'nice', 'false', 'true'), ('217', 'nifty', 'false', 'true'), ('218', 'nimble', 'false', 'true'), ('219', 'noble', 'false', 'true'), ('220', 'normal', 'false', 'true'), ('221', 'noted', 'false', 'true'), ('222', 'novel', 'false', 'true'), ('223', 'okay', 'false', 'true'), ('224', 'open', 'false', 'true'), ('225', 'outrageous', 'false', 'true'), ('226', 'overt', 'false', 'true'), ('227', 'pacific', 'false', 'true'), ('228', 'parched', 'false', 'true'), ('229', 'peachy', 'false', 'true'), ('230', 'peppy', 'false', 'true'), ('231', 'pithy', 'false', 'true'), ('232', 'placid', 'false', 'true'), ('233', 'pleasant', 'false', 'true'), ('234', 'plucky', 'false', 'true'), ('235', 'plum', 'false', 'true'), ('236', 'poetic', 'false', 'true'), ('237', 'poised', 'false', 'true'), ('238', 'polite', 'false', 'true'), ('239', 'posh', 'false', 'true'), ('240', 'potent', 'false', 'true'), ('241', 'pretty', 'false', 'true'), ('242', 'prime', 'false', 'true'), ('243', 'primo', 'false', 'true'), ('244', 'prized', 'false', 'true'), ('245', 'pro', 'false', 'true'), ('246', 'prompt', 'false', 'true'), ('247', 'proper', 'false', 'true'), ('248', 'proud', 'false', 'true'), ('249', 'pumped', 'false', 'true'), ('250', 'punchy', 'false', 'true'), ('251', 'pure', 'false', 'true'), ('252', 'purring', 'false', 'true'), ('253', 'quaint', 'false', 'true'), ('254', 'quick', 'false', 'true'), ('255', 'quiet', 'false', 'true'), ('256', 'rad', 'false', 'true'), ('257', 'radioactive', 'false', 'true'), ('258', 'rapid', 'false', 'true'), ('259', 'rare', 'false', 'true'), ('260', 'ready', 'false', 'true'), ('261', 'real', 'false', 'true'), ('262', 'regal', 'false', 'true'), ('263', 'resilient', 'false', 'true'), ('264', 'rich', 'false', 'true'), ('265', 'right', 'false', 'true'), ('266', 'robust', 'false', 'true'), ('267', 'rooted', 'false', 'true'), ('268', 'rosy', 'false', 'true'), ('269', 'rugged', 'false', 'true'), ('270', 'safe', 'false', 'true'), ('271', 'sassy', 'false', 'true'), ('272', 'saucy', 'false', 'true'), ('273', 'savvy', 'false', 'true'), ('274', 'scenic', 'false', 'true'), ('275', 'secret', 'false', 'true'), ('276', 'seemly', 'false', 'true'), ('277', 'serene', 'false', 'true'), ('278', 'sharp', 'false', 'true'), ('279', 'showy', 'false', 'true'), ('280', 'shrewd', 'false', 'true'), ('281', 'simple', 'false', 'true'), ('282', 'sleek', 'false', 'true'), ('283', 'slick', 'false', 'true'), ('284', 'smart', 'false', 'true'), ('285', 'smiley', 'false', 'true'), ('286', 'smooth', 'false', 'true'), ('287', 'snappy', 'false', 'true'), ('288', 'snazzy', 'false', 'true'), ('289', 'snowy', 'false', 'true'), ('290', 'snugly', 'false', 'true'), ('291', 'social', 'false', 'true'), ('292', 'sole', 'false', 'true'), ('293', 'solitary', 'false', 'true'), ('294', 'sound', 'false', 'true'), ('295', 'spacial', 'false', 'true'), ('296', 'spicy', 'false', 'true'), ('297', 'spiffy', 'false', 'true'), ('298', 'spry', 'false', 'true'), ('299', 'stable', 'false', 'true'), ('300', 'star', 'false', 'true'), ('301', 'stark', 'false', 'true'), ('302', 'steady', 'false', 'true'), ('303', 'stoic', 'false', 'true'), ('304', 'strong', 'false', 'true'), ('305', 'stunning', 'false', 'true'), ('306', 'sturdy', 'false', 'true'), ('307', 'suave', 'false', 'true'), ('308', 'subtle', 'false', 'true'), ('309', 'sunny', 'false', 'true'), ('310', 'sunset', 'false', 'true'), ('311', 'super', 'false', 'true'), ('312', 'superb', 'false', 'true'), ('313', 'sure', 'false', 'true'), ('314', 'swank', 'false', 'true'), ('315', 'sweet', 'false', 'true'), ('316', 'swell', 'false', 'true'), ('317', 'swift', 'false', 'true'), ('318', 'talented', 'false', 'true'), ('319', 'teal', 'false', 'true'), ('320', 'tidy', 'false', 'true'), ('321', 'timely', 'false', 'true'), ('322', 'touted', 'false', 'true'), ('323', 'tranquil', 'false', 'true'), ('324', 'trim', 'false', 'true'), ('325', 'tropical', 'false', 'true'), ('326', 'TRUE', 'false', 'true'), ('327', 'trusty', 'false', 'true'), ('328', 'undisturbed', 'false', 'true'), ('329', 'unique', 'false', 'true'), ('330', 'united', 'false', 'true'), ('331', 'unsightly', 'false', 'true'), ('332', 'unwavering', 'false', 'true'), ('333', 'upbeat', 'false', 'true'), ('334', 'uplifting', 'false', 'true'), ('335', 'urbane', 'false', 'true'), ('336', 'usable', 'false', 'true'), ('337', 'useful', 'false', 'true'), ('338', 'utmost', 'false', 'true'), ('339', 'valid', 'false', 'true'), ('340', 'vast', 'false', 'true'), ('341', 'vestal', 'false', 'true'), ('342', 'viable', 'false', 'true'), ('343', 'vital', 'false', 'true'), ('344', 'vivid', 'false', 'true'), ('345', 'vocal', 'false', 'true'), ('346', 'vogue', 'false', 'true'), ('347', 'volant', 'false', 'true'), ('348', 'wandering', 'false', 'true'), ('349', 'wanted', 'false', 'true'), ('350', 'warm', 'false', 'true'), ('351', 'wealthy', 'false', 'true'), ('352', 'whispering', 'false', 'true'), ('353', 'whole', 'false', 'true'), ('354', 'winged', 'false', 'true'), ('355', 'wired', 'false', 'true'), ('356', 'wise', 'false', 'true'), ('357', 'witty', 'false', 'true'), ('358', 'wooden', 'false', 'true'), ('359', 'worthy', 'false', 'true'), ('360', 'zealous', 'false', 'true'), ('361', 'abyss', 'true', 'false'), ('362', 'animal', 'true', 'false'), ('363', 'apple', 'true', 'false'), ('364', 'atoll', 'true', 'false'), ('365', 'aurora', 'true', 'false'), ('366', 'autumn', 'true', 'false'), ('367', 'bacon', 'true', 'false'), ('368', 'badlands', 'true', 'false'), ('369', 'ball', 'true', 'false'), ('370', 'banana', 'true', 'false'), ('371', 'bath', 'true', 'false'), ('372', 'beach', 'true', 'false'), ('373', 'bear', 'true', 'false'), ('374', 'bed', 'true', 'false'), ('375', 'bee', 'true', 'false'), ('376', 'bike', 'true', 'false'), ('377', 'bird', 'true', 'false'), ('378', 'boat', 'true', 'false'), ('379', 'book', 'true', 'false'), ('380', 'bowl', 'true', 'false'), ('381', 'branch', 'true', 'false'), ('382', 'bread', 'true', 'false'), ('383', 'breeze', 'true', 'false'), ('384', 'briars', 'true', 'false'), ('385', 'brook', 'true', 'false'), ('386', 'brush', 'true', 'false'), ('387', 'bunny', 'true', 'false'), ('388', 'candy', 'true', 'false'), ('389', 'canopy', 'true', 'false'), ('390', 'canyon', 'true', 'false'), ('391', 'car', 'true', 'false'), ('392', 'cat', 'true', 'false'), ('393', 'cave', 'true', 'false'), ('394', 'cavern', 'true', 'false'), ('395', 'cereal', 'true', 'false'), ('396', 'chair', 'true', 'false'), ('397', 'chasm', 'true', 'false'), ('398', 'chip', 'true', 'false'), ('399', 'cliff', 'true', 'false'), ('400', 'coal', 'true', 'false'), ('401', 'coast', 'true', 'false'), ('402', 'cookie', 'true', 'false'), ('403', 'cove', 'true', 'false'), ('404', 'cow', 'true', 'false'), ('405', 'crater', 'true', 'false'), ('406', 'creek', 'true', 'false'), ('407', 'darkness', 'true', 'false'), ('408', 'dawn', 'true', 'false'), ('409', 'desert', 'true', 'false'), ('410', 'dew', 'true', 'false'), ('411', 'dog', 'true', 'false'), ('412', 'door', 'true', 'false'), ('413', 'dove', 'true', 'false'), ('414', 'drylands', 'true', 'false'), ('415', 'duck', 'true', 'false'), ('416', 'dusk', 'true', 'false'), ('417', 'earth', 'true', 'false'), ('418', 'fall', 'true', 'false'), ('419', 'farm', 'true', 'false'), ('420', 'fern', 'true', 'false'), ('421', 'field', 'true', 'false'), ('422', 'firefly', 'true', 'false'), ('423', 'fish', 'true', 'false'), ('424', 'fjord', 'true', 'false'), ('425', 'flood', 'true', 'false'), ('426', 'flower', 'true', 'false'), ('427', 'flowers', 'true', 'false'), ('428', 'fog', 'true', 'false'), ('429', 'foliage', 'true', 'false'), ('430', 'forest', 'true', 'false'), ('431', 'freeze', 'true', 'false'), ('432', 'frog', 'true', 'false'), ('433', 'fu', 'true', 'false'), ('434', 'galaxy', 'true', 'false'), ('435', 'garden', 'true', 'false'), ('436', 'geyser', 'true', 'false'), ('437', 'gift', 'true', 'false'), ('438', 'glass', 'true', 'false'), ('439', 'grove', 'true', 'false'), ('440', 'guide', 'true', 'false'), ('441', 'guru', 'true', 'false'), ('442', 'hat', 'true', 'false'), ('443', 'hug', 'true', 'false'), ('444', 'hero', 'true', 'false'), ('445', 'hill', 'true', 'false'), ('446', 'horse', 'true', 'false'), ('447', 'house', 'true', 'false'), ('448', 'hurricane', 'true', 'false'), ('449', 'ice', 'true', 'false'), ('450', 'iceberg', 'true', 'false'), ('451', 'island', 'true', 'false'), ('452', 'juice', 'true', 'false'), ('453', 'lagoon', 'true', 'false'), ('454', 'lake', 'true', 'false'), ('455', 'land', 'true', 'false'), ('456', 'lawn', 'true', 'false'), ('457', 'leaf', 'true', 'false'), ('458', 'leaves', 'true', 'false'), ('459', 'light', 'true', 'false'), ('460', 'lion', 'true', 'false'), ('461', 'marsh', 'true', 'false'), ('462', 'meadow', 'true', 'false'), ('463', 'milk', 'true', 'false'), ('464', 'mist', 'true', 'false'), ('465', 'moon', 'true', 'false'), ('466', 'moss', 'true', 'false'), ('467', 'mountain', 'true', 'false'), ('468', 'mouse', 'true', 'false'), ('469', 'nature', 'true', 'false'), ('470', 'oasis', 'true', 'false'), ('471', 'ocean', 'true', 'false'), ('472', 'pants', 'true', 'false'), ('473', 'peak', 'true', 'false'), ('474', 'pebble', 'true', 'false'), ('475', 'pine', 'true', 'false'), ('476', 'pilot', 'true', 'false'), ('477', 'plane', 'true', 'false'), ('478', 'planet', 'true', 'false'), ('479', 'plant', 'true', 'false'), ('480', 'plateau', 'true', 'false'), ('481', 'pond', 'true', 'false'), ('482', 'prize', 'true', 'false'), ('483', 'rabbit', 'true', 'false'), ('484', 'rain', 'true', 'false'), ('485', 'range', 'true', 'false'), ('486', 'reef', 'true', 'false'), ('487', 'reserve', 'true', 'false'), ('488', 'resonance', 'true', 'false'), ('489', 'river', 'true', 'false'), ('490', 'rock', 'true', 'false'), ('491', 'sage', 'true', 'false'), ('492', 'salute', 'true', 'false'), ('493', 'sanctuary', 'true', 'false'), ('494', 'sand', 'true', 'false'), ('495', 'sands', 'true', 'false'), ('496', 'shark', 'true', 'false'), ('497', 'shelter', 'true', 'false'), ('498', 'shirt', 'true', 'false'), ('499', 'shoe', 'true', 'false'), ('500', 'silence', 'true', 'false'), ('501', 'sky', 'true', 'false'), ('502', 'smokescreen', 'true', 'false'), ('503', 'snowflake', 'true', 'false'), ('504', 'socks', 'true', 'false'), ('505', 'soil', 'true', 'false'), ('506', 'soul', 'true', 'false'), ('507', 'soup', 'true', 'false'), ('508', 'sparrow', 'true', 'false'), ('509', 'spoon', 'true', 'false'), ('510', 'spring', 'true', 'false'), ('511', 'star', 'true', 'false'), ('512', 'stone', 'true', 'false'), ('513', 'storm', 'true', 'false'), ('514', 'stream', 'true', 'false'), ('515', 'summer', 'true', 'false'), ('516', 'summit', 'true', 'false'), ('517', 'sun', 'true', 'false'), ('518', 'sunrise', 'true', 'false'), ('519', 'sunset', 'true', 'false'), ('520', 'sunshine', 'true', 'false'), ('521', 'surf', 'true', 'false'), ('522', 'swamp', 'true', 'false'), ('523', 'table', 'true', 'false'), ('524', 'teacher', 'true', 'false'), ('525', 'temple', 'true', 'false'), ('526', 'thorns', 'true', 'false'), ('527', 'tiger', 'true', 'false'), ('528', 'tigers', 'true', 'false'), ('529', 'towel', 'true', 'false'), ('530', 'train', 'true', 'false'), ('531', 'tree', 'true', 'false'), ('532', 'truck', 'true', 'false'), ('533', 'tsunami', 'true', 'false'), ('534', 'tundra', 'true', 'false'), ('535', 'valley', 'true', 'false'), ('536', 'volcano', 'true', 'false'), ('537', 'water', 'true', 'false'), ('538', 'waterfall', 'true', 'false'), ('539', 'waves', 'true', 'false'), ('540', 'wild', 'true', 'false'), ('541', 'willow', 'true', 'false'), ('542', 'window', 'true', 'false'), ('543', 'winds', 'true', 'false'), ('544', 'winter', 'true', 'false'), ('545', 'zebra', 'true', 'false');




INSERT INTO public.gradebook_columns (id, sort_order, gradebook_id, class_id, slug, name, description, score_expression, render_expression, max_score, dependencies) VALUES
(2, 2, 1, 1, 'skill-1', 'Skill #1', 'Score for skill #1', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(3, 3, 1, 1, 'skill-2', 'Skill #2', 'Score for skill #2', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(4, 4, 1, 1, 'skill-3', 'Skill #3', 'Score for skill #3', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(5, 5, 1, 1, 'skill-4', 'Skill #4', 'Score for skill #4', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(6, 6, 1, 1, 'skill-5', 'Skill #5', 'Score for skill #5', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(7, 7, 1, 1, 'skill-6', 'Skill #6', 'Score for skill #6', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(8, 8, 1, 1, 'skill-7', 'Skill #7', 'Score for skill #7', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(9, 9, 1, 1, 'skill-8', 'Skill #8', 'Score for skill #8', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(10, 10, 1, 1, 'skill-9', 'Skill #9', 'Score for skill #9', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(11, 11, 1, 1, 'skill-10', 'Skill #10', 'Score for skill #10', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(12, 12, 1, 1, 'skill-11', 'Skill #11', 'Score for skill #11', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
(13, 13, 1, 1, 'skill-12', 'Skill #12', 'Score for skill #12', NULL, 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])', 2, NULL),
-- Expectation level columns
(14, 14, 1, 1, 'meets-expectations', 'Skills Meeting Expectations', 'Total number of skills at meets expectations level', 'countif(gradebook_columns("skill-*"), f(x) = x.score == 2)', NULL, 12, '{"gradebook_columns" : [2,3,4,5,6,7,8,9,10,11,12,13]}'),
(15, 15, 1, 1, 'approaching-expectations', 'Skills Approaching Expectations', 'Total number of skills at approaching expectations level', 'countif(gradebook_columns("skill-*"), f(x) = x.score == 1)', NULL, 12,  '{"gradebook_columns" : [2,3,4,5,6,7,8,9,10,11,12,13]}'),
(16, 16, 1, 1, 'does-not-meet-expectations', 'Skills Not Meeting Expectations', 'Total number of skills at does not meet expectations level', 'countif(gradebook_columns("skill-*"), f(x) = x.score == 0)', NULL, 12,  '{"gradebook_columns" : [2,3,4,5,6,7,8,9,10,11,12,13]}'),
-- HW columns 1-5
(17, 17, 1, 1, 'hw-1', 'HW #1', 'Score for HW #1', NULL, NULL, 100, NULL),
(18, 18, 1, 1, 'hw-2', 'HW #2', 'Score for HW #2', NULL, NULL, 100, NULL),
(19, 19, 1, 1, 'hw-3', 'HW #3', 'Score for HW #3', NULL, NULL, 100, NULL),
(20, 20, 1, 1, 'hw-4', 'HW #4', 'Score for HW #4', NULL, NULL, 100, NULL),
(21, 21, 1, 1, 'hw-5', 'HW #5', 'Score for HW #5', NULL, NULL, 100, NULL),
-- Avg HW
(22, 22, 1, 1, 'average.hw', 'Avg HW', 'Average of all homework assignments', 'mean(gradebook_columns("hw-*"))', NULL, 100, '{"gradebook_columns": [17,18,19,20,21]}'),
-- Lab columns 1-10
(23, 23, 1, 1, 'lab-1', 'Lab #1', 'Participation in Lab #1', NULL, 'checkOrX(score)', 1, NULL),
(24, 24, 1, 1, 'lab-2', 'Lab #2', 'Participation in Lab #2', NULL, 'checkOrX(score)', 1, NULL),
(25, 25, 1, 1, 'lab-3', 'Lab #3', 'Participation in Lab #3', NULL, 'checkOrX(score)', 1, NULL),
(26, 26, 1, 1, 'lab-4', 'Lab #4', 'Participation in Lab #4', NULL, 'checkOrX(score)', 1, NULL),
(27, 27, 1, 1, 'lab-5', 'Lab #5', 'Participation in Lab #5', NULL, 'checkOrX(score)', 1, NULL),
(28, 28, 1, 1, 'lab-6', 'Lab #6', 'Participation in Lab #6', NULL, 'checkOrX(score)', 1, NULL),
(29, 29, 1, 1, 'lab-7', 'Lab #7', 'Participation in Lab #7', NULL, 'checkOrX(score)', 1, NULL),
(30, 30, 1, 1, 'lab-8', 'Lab #8', 'Participation in Lab #8', NULL, 'checkOrX(score)', 1, NULL),
(31, 31, 1, 1, 'lab-9', 'Lab #9', 'Participation in Lab #9', NULL, 'checkOrX(score)', 1, NULL),
(32, 32, 1, 1, 'lab-10', 'Lab #10', 'Participation in Lab #10', NULL, 'checkOrX(score)', 1, NULL),
-- Total Labs
(33, 33, 1, 1, 'total-labs', 'Total Labs', 'Total number of labs participated in', 'countif(gradebook_columns("lab-*"), f(x) = not x.is_missing and x.score>0)', NULL, 10, '{"gradebook_columns": [23,24,25,26,27,28,29,30,31,32]}'),
-- Final Score
(34, 34, 1, 1, 'final', 'Final Score', 'Grades will be primarily assigned by achievement levels of the course Skills, with required grade thresholds on HW for each letter grade, and + (other than A) given for participation in 8 or more out of 10 labs, - given for participating in fewer than 6 out of ten labs.
Grade | Skills Needed | HW Needed 
-- | -- | --
A | Meets expectations on 10+/12, Approaching expectations on remainder | 85% or better
B | Meets expectations on 8+/12, Approaching expectations on remainder | 75% or better
C | Meets expectations on 5+/12, Approaching expectations on remainder | 65% or better
D | Approaching expectations or better on 9+/12 | 55% or better
', 'CriteriaA = gradebook_columns("meets-expectations") >= 10 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 85
CriteriaB = gradebook_columns("meets-expectations") >= 8 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 75
CriteriaC = gradebook_columns("meets-expectations") >= 5 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 65
CriteriaD = gradebook_columns("approaching-expectations") >= 9 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 55
CriteriaPlus = gradebook_columns("total-labs") >= 8
CriteriaMinus = gradebook_columns("total-labs") < 6
letter = case_when([CriteriaA, 95;
CriteriaB, 85;
CriteriaC, 75;
CriteriaD, 65;
true, 0])
mod = case_when([CriteriaPlus, 3;
CriteriaMinus, -3;
true, 0])
final = max(letter + mod, 0)
final;', 'letter(score)', 100, '{"gradebook_columns":[14, 15, 16, 22, 33]}');



INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin
) VALUES
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'test1@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'test2@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333331', 'authenticated', 'authenticated', 'nullpointer@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333332', 'authenticated', 'authenticated', 'segfault@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'infiniteloop@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333334', 'authenticated', 'authenticated', 'offbyone@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333335', 'authenticated', 'authenticated', 'racecondition@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333336', 'authenticated', 'authenticated', 'rubberduck@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333337', 'authenticated', 'authenticated', 'stackoverflow@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333338', 'authenticated', 'authenticated', 'syntaxerror@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333339', 'authenticated', 'authenticated', 'foobar@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333340', 'authenticated', 'authenticated', 'helloworld@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE);

DO $$
DECLARE
  eva_profile_id uuid;
  alyssa_profile_id uuid;
  alyssa_repo_id int8;
  alyssa_check_run_id int8;
  alyssa_submission_id int8;
BEGIN
  SELECT p.id INTO eva_profile_id
  FROM public.profiles p
  inner join public.user_roles r on r.private_profile_id=p.id
  WHERE r.user_id='11111111-1111-1111-1111-111111111111';

  SELECT p.id INTO alyssa_profile_id
  FROM public.profiles p
  inner join public.user_roles r on r.private_profile_id=p.id
  where r.user_id='22222222-2222-2222-2222-222222222222';

  UPDATE public.profiles
  SET name = 'Eva Lu Ator'
  WHERE id = eva_profile_id;

  UPDATE public.profiles
  SET name = 'Alyssa P Hacker'
  WHERE id = alyssa_profile_id;

  update public.user_roles set role='instructor' where private_profile_id=eva_profile_id;


INSERT into public.repositories(assignment_id, repository, class_id, profile_id, synced_handout_sha, synced_repo_sha)
  VALUES (1, 'not-actually/repository', 1, alyssa_profile_id, 'none', 'none') RETURNING id into alyssa_repo_id;

INSERT INTO public.repository_check_runs (class_id, repository_id, check_run_id, status, sha, commit_message)
  VALUES (1, alyssa_repo_id, 1, '{}', 'none', 'none') RETURNING id into alyssa_check_run_id;

  INSERT into public.submissions (
    id, assignment_id, profile_id, sha, repository, run_attempt,run_number,class_id, repository_check_run_id, repository_id
  ) VALUES
  (1, 1, alyssa_profile_id, 'none', 'not-actually/a-repository', 1, 1,1, alyssa_check_run_id, alyssa_repo_id) RETURNING id into alyssa_submission_id;
 INSERT INTO public.submission_files (name,contents,class_id, profile_id, submission_id)
 VALUES ('sample.java','package com.pawtograder.example.java;

public class Entrypoint {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }

    /*
     * This method takes two integers and returns their sum.
     * 
     * @param a the first integer
     * @param b the second integer
     * @return the sum of a and b
     */
    public int doMath(int a, int b) {
        return a+b;
    }

    /**
     * This method returns a message, "Hello, World!"
     * @return
     */
    public String getMessage() {
        
        return "Hello, World!";
    }
} ', 1, alyssa_profile_id, alyssa_submission_id);
 
 INSERT into grader_results (id, submission_id, score, class_id, profile_id, lint_passed,lint_output, lint_output_format,max_score) VALUES (alyssa_submission_id, alyssa_submission_id, 5, 1, alyssa_profile_id, TRUE,'no lint output','markdown',10);
 INSERT INTO grader_result_tests (score,max_score,name,name_format,output,output_format,class_id,student_id,grader_result_id,is_released) VALUES
 (0,5,'test 1','text','here is a 
 bunch
 of output
 **wow**', 'markdown', 1, alyssa_profile_id, alyssa_submission_id, TRUE),
(5,5,'test 2','text','here is a 
 bunch
 **MORE**
 output
 **wow**', 'markdown', 1, alyssa_profile_id, alyssa_submission_id, TRUE);

update public.gradebook_column_students set score=100, is_missing=false where gradebook_column_id=3 and student_id=alyssa_profile_id;
update public.gradebook_column_students set score=0,is_excused=true, is_missing=false where gradebook_column_id=4 and student_id=alyssa_profile_id;
update public.gradebook_column_students set score=100, is_missing=false where gradebook_column_id=5 and student_id=alyssa_profile_id;


  
END $$;

-- Add 10 new students' submissions
DO $$
DECLARE
  student_profile_id uuid;
  student_repo_id int8;
  student_check_run_id int8;
  student_submission_id int8;
  student_user_id uuid;
  i int;
  student_uuid_arr uuid[] := ARRAY[
    '33333333-3333-3333-3333-333333333331',
    '33333333-3333-3333-3333-333333333332',
    '33333333-3333-3333-3333-333333333333',
    '33333333-3333-3333-3333-333333333334',
    '33333333-3333-3333-3333-333333333335',
    '33333333-3333-3333-3333-333333333336',
    '33333333-3333-3333-3333-333333333337',
    '33333333-3333-3333-3333-333333333338',
    '33333333-3333-3333-3333-333333333339',
    '33333333-3333-3333-3333-333333333340'
  ];
BEGIN
  FOR i IN 1..10 LOOP
    student_user_id := student_uuid_arr[i];
    -- Get the profile_id for this student
    SELECT p.id INTO student_profile_id
    FROM public.profiles p
    INNER JOIN public.user_roles r ON r.private_profile_id = p.id
    WHERE r.user_id = student_user_id;

    -- Insert repository
    INSERT INTO public.repositories(assignment_id, repository, class_id, profile_id, synced_handout_sha, synced_repo_sha)
      VALUES (1, 'not-actually/repository-' || i, 1, student_profile_id, 'none', 'none')
      RETURNING id INTO student_repo_id;

    -- Insert repository check run
    INSERT INTO public.repository_check_runs (class_id, repository_id, check_run_id, status, sha, commit_message)
      VALUES (1, student_repo_id, 1, '{}', 'none', 'none')
      RETURNING id INTO student_check_run_id;

    -- Insert submission
    INSERT INTO public.submissions (
      id, assignment_id, profile_id, sha, repository, run_attempt, run_number, class_id, repository_check_run_id, repository_id
    ) VALUES (
      i + 1, 1, student_profile_id, 'none', 'not-actually/a-repository-' || i, 1, 1, 1, student_check_run_id, student_repo_id
    ) RETURNING id INTO student_submission_id;

    UPDATE public.submission_reviews set total_score=i*5 where submission_id=student_submission_id;

    -- Insert submission file
    INSERT INTO public.submission_files (name, contents, class_id, profile_id, submission_id)
    VALUES ('sample.java', 'package com.pawtograder.example.java;\n\npublic class Entrypoint {\n    public static void main(String[] args) {\n        System.out.println("Hello from student ' || i || '!");\n    }\n\n    public int doMath(int a, int b) {\n        return a+b;\n    }\n\n    public String getMessage() {\n        return "Hello from student ' || i || '!";\n    }\n}', 1, student_profile_id, student_submission_id);

    -- Insert grader results
    INSERT INTO grader_results (id, submission_id, score, class_id, profile_id, lint_passed, lint_output, lint_output_format, max_score)
    VALUES (student_submission_id, student_submission_id, 5, 1, student_profile_id, TRUE, 'no lint output', 'markdown', 10);

    -- Insert grader result tests
    INSERT INTO grader_result_tests (score, max_score, name, name_format, output, output_format, class_id, student_id, grader_result_id, is_released)
    VALUES
      (0, 5, 'test 1', 'text', 'output for student ' || i, 'markdown', 1, student_profile_id, student_submission_id, TRUE),
      (5, 5, 'test 2', 'text', 'output for student ' || i, 'markdown', 1, student_profile_id, student_submission_id, TRUE);

   update public.gradebook_column_students set score=i*5, is_missing=false where gradebook_column_id=3 and student_id=student_profile_id;
   update public.gradebook_column_students set score=i*7, is_missing=false where gradebook_column_id=4 and student_id=student_profile_id;
   update public.gradebook_column_students set score=i*10, is_missing=false where gradebook_column_id=5 and student_id=student_profile_id;

  END LOOP;
END $$;

-- Set up comprehensive gradebook data for different grade scenarios
DO $$
DECLARE
  student_profile_id uuid;
  student_user_id uuid;
  i int;
  student_uuid_arr uuid[] := ARRAY[
    '22222222-2222-2222-2222-222222222222', -- Alyssa (existing)
    '33333333-3333-3333-3333-333333333331', -- Student 1: A
    '33333333-3333-3333-3333-333333333332', -- Student 2: A-
    '33333333-3333-3333-3333-333333333333', -- Student 3: B+
    '33333333-3333-3333-3333-333333333334', -- Student 4: B
    '33333333-3333-3333-3333-333333333335', -- Student 5: B-
    '33333333-3333-3333-3333-333333333336', -- Student 6: C+
    '33333333-3333-3333-3333-333333333337', -- Student 7: C
    '33333333-3333-3333-3333-333333333338', -- Student 8: C-
    '33333333-3333-3333-3333-333333333339', -- Student 9: D+
    '33333333-3333-3333-3333-333333333340'  -- Student 10: D
  ];
BEGIN
  FOR i IN 1..11 LOOP
    student_user_id := student_uuid_arr[i];
    
    -- Get the profile_id for this student
    SELECT p.id INTO student_profile_id
    FROM public.profiles p
    INNER JOIN public.user_roles r ON r.private_profile_id = p.id
    WHERE r.user_id = student_user_id;

    RAISE NOTICE 'Setting up gradebook data for student %', student_profile_id;
    -- Set up different grade scenarios based on i
    CASE i
      WHEN 1 THEN -- Alyssa: A grade (10+ meets, 85%+ HW, 8+ labs)
        -- Skills: 10 meets expectations (score 2), 2 approaching (score 1)
        FOR col IN 2..11 LOOP
          RAISE NOTICE 'Setting score for column %', col;
          RAISE NOTICE 'IDs that will be updated: %', (SELECT ARRAY_AGG(id) FROM public.gradebook_column_students WHERE gradebook_column_id = col AND student_id = student_profile_id);
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 12..13 LOOP
                  RAISE NOTICE 'IDs that will be updated: %', (SELECT ARRAY_AGG(id) FROM public.gradebook_column_students WHERE gradebook_column_id = col AND student_id = student_profile_id);
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        -- HW: 85%+ average
        UPDATE public.gradebook_column_students SET score = 90, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 85, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 90, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 85, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 90, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        -- Labs: 8+ participation
        FOR col IN 23..30 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 31..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 2 THEN -- Student 1: A- grade (10+ meets, 85%+ HW, 6-7 labs)
        FOR col IN 2..11 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 12..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 90, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 85, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 90, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 85, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 90, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..28 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 29..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 3 THEN -- Student 2: B+ grade (8+ meets, 75%+ HW, 8+ labs)
        FOR col IN 2..9 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 10..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 75, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 75, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..30 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 31..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 4 THEN -- Student 3: B grade (8+ meets, 75%+ HW, 6-7 labs)
        FOR col IN 2..9 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 10..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 75, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 75, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..28 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 29..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 5 THEN -- Student 4: B- grade (8+ meets, 75%+ HW, <6 labs)
        FOR col IN 2..9 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 10..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 75, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 75, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 80, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..26 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 27..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 6 THEN -- Student 5: C+ grade (5+ meets, 65%+ HW, 8+ labs)
        FOR col IN 2..6 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 7..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 65, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 65, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..30 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 31..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 7 THEN -- Student 6: C grade (5+ meets, 65%+ HW, 6-7 labs)
        FOR col IN 2..6 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 7..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 65, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 65, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..28 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 29..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 8 THEN -- Student 7: C- grade (5+ meets, 65%+ HW, <6 labs)
        FOR col IN 2..6 LOOP
          UPDATE public.gradebook_column_students SET score = 2, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 7..13 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 65, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 65, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 70, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..26 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 27..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 9 THEN -- Student 8: D+ grade (9+ approaching, 8+ labs)
        FOR col IN 2..10 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 11..13 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 55, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 55, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..30 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 31..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 10 THEN -- Student 9: D grade (9+ approaching, 6-7 labs)
        FOR col IN 2..10 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 11..13 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 55, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 55, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..28 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 29..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

      WHEN 11 THEN -- Student 10: F grade (<9 approaching, or <65% HW)
        FOR col IN 2..9 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 10..13 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 17 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 55, is_excused = false, is_missing = false WHERE gradebook_column_id = 18 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 19 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 55, is_excused = false, is_missing = false WHERE gradebook_column_id = 20 AND student_id = student_profile_id;
        UPDATE public.gradebook_column_students SET score = 60, is_excused = false, is_missing = false WHERE gradebook_column_id = 21 AND student_id = student_profile_id;
        FOR col IN 23..26 LOOP
          UPDATE public.gradebook_column_students SET score = 1, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;
        FOR col IN 27..32 LOOP
          UPDATE public.gradebook_column_students SET score = 0, is_excused = false, is_missing = false WHERE gradebook_column_id = col AND student_id = student_profile_id;
        END LOOP;

    END CASE;

  END LOOP;
END $$;

SELECT setval('classes_id_seq', (SELECT MAX(id) FROM "classes"));
SELECT setval('assignments_id_seq', (SELECT MAX(id) FROM "assignments"));
SELECT setval('gradebooks_id_seq', (SELECT MAX(id) FROM "gradebooks"));
SELECT setval('gradebook_columns_id_seq', (SELECT MAX(id) FROM "gradebook_columns"));
SELECT setval('submissio_id_seq', (SELECT MAX(id) FROM "submissions"));
SELECT setval('repositories_id_seq', (SELECT MAX(id) FROM "repositories"));
SELECT setval('repository_check_runs_id_seq', (SELECT MAX(id) FROM "repository_check_runs"));
SELECT setval('grader_results_id_seq', (SELECT MAX(id) FROM "grader_results"));

-- Flashcard seed data
DO $$
DECLARE
  cs101_deck_id int8;
  java_deck_id int8;
  eva_user_id uuid := '11111111-1111-1111-1111-111111111111';
  demo_class_id int8 := 1;
BEGIN

INSERT INTO public.flashcard_decks (class_id, creator_id, name, description)
VALUES (
  demo_class_id,
  eva_user_id,
  'Demo CS 101 Deck',
  'Flashcards for introductory computer science concepts.'
) RETURNING id INTO cs101_deck_id;

INSERT INTO public.flashcards (class_id, deck_id, title, prompt, answer)
VALUES
(demo_class_id, cs101_deck_id, 'Algorithm', 'What is an algorithm?', 'A step-by-step procedure for solving a problem or accomplishing some end.'),
(demo_class_id, cs101_deck_id, 'Data Structure', 'What is a data structure?', 'A particular way of organizing data in a computer so that it can be used effectively.'),
(demo_class_id, cs101_deck_id, 'Variable', 'What is a variable in programming?', 'A storage location, with an associated symbolic name, which contains some known or unknown quantity of information referred to as a value.');


INSERT INTO public.flashcard_decks (class_id, creator_id, name, description)
VALUES (
  demo_class_id,
  eva_user_id,
  'Java Fundamentals',
  'Basic concepts in Java programming.'
) RETURNING id INTO java_deck_id;

INSERT INTO public.flashcards (class_id, deck_id, title, prompt, answer)
VALUES
(demo_class_id, java_deck_id, 'Java File Extension', 'What is the file extension for a Java source file?', '`.java`'),
(demo_class_id, java_deck_id, 'Java Class File Extension', 'What is the file extension for a compiled Java class file?', '`.class`'),
(demo_class_id, java_deck_id, 'Compile Java', 'What command compiles a Java file named HelloWorld.java?', '`javac HelloWorld.java`'),
(demo_class_id, java_deck_id, 'Run Java', 'What command runs a compiled Java class named HelloWorld?', '`java HelloWorld`'),
(demo_class_id, java_deck_id, 'Class Keyword', 'What keyword is used to define a class in Java?', '`class`'),
(demo_class_id, java_deck_id, 'Single-line Comment', 'How do you write a single-line comment in Java?', '`// comment`'),
(demo_class_id, java_deck_id, 'Multi-line Comment Start', 'How do you start a multi-line comment in Java?', '`/*`'),
(demo_class_id, java_deck_id, 'Multi-line Comment End', 'How do you end a multi-line comment in Java?', '`*/`'),
(demo_class_id, java_deck_id, 'Main Method', 'What is the entry point method for a Java application?', '`public static void main(String[] args)`'),
(demo_class_id, java_deck_id, 'Print Line', 'How do you print "Hello, World!" to the console?', '`System.out.println("Hello, World!");`'),
(demo_class_id, java_deck_id, 'Final Keyword', 'What keyword is used to create a constant variable?', '`final`'),
(demo_class_id, java_deck_id, 'Declare int', 'How do you declare an integer variable named count?', '`int count;`'),
(demo_class_id, java_deck_id, 'Assign Value', 'How do you assign the value 10 to a variable named x?', '`x = 10;`'),
(demo_class_id, java_deck_id, 'Boolean Type', 'What data type is used for true/false values?', '`boolean`'),
(demo_class_id, java_deck_id, 'Declare Boolean', 'How do you declare a boolean variable named isActive?', '`boolean isActive;`'),
(demo_class_id, java_deck_id, 'Char Type', 'What data type is used for single characters?', '`char`'),
(demo_class_id, java_deck_id, 'Declare Char', 'How do you declare a character variable named grade with value ''A''?', '`char grade = ''A'';`'),
(demo_class_id, java_deck_id, 'Double Type', 'What data type is used for decimal numbers?', '`double`'),
(demo_class_id, java_deck_id, 'Declare Double', 'How do you declare a double variable named price?', '`double price;`'),
(demo_class_id, java_deck_id, 'Declare String', 'How do you declare a String variable named name?', '`String name;`'),
(demo_class_id, java_deck_id, 'String Concatenation', 'How do you concatenate two strings a and b?', '`a + b`'),
(demo_class_id, java_deck_id, 'String Length', 'How do you get the length of a String str?', '`str.length()`'),
(demo_class_id, java_deck_id, 'String Equality', 'How do you compare two strings for equality?', '`str1.equals(str2)`'),
(demo_class_id, java_deck_id, 'Addition Operator', 'What is the operator for addition in Java?', '`+`'),
(demo_class_id, java_deck_id, 'Subtraction Operator', 'What is the operator for subtraction in Java?', '`-`'),
(demo_class_id, java_deck_id, 'Multiplication Operator', 'What is the operator for multiplication in Java?', '`*`'),
(demo_class_id, java_deck_id, 'Division Operator', 'What is the operator for division in Java?', '`/`'),
(demo_class_id, java_deck_id, 'Modulus Operator', 'What is the operator for modulus (remainder) in Java?', '`%`'),
(demo_class_id, java_deck_id, 'Logical AND', 'What is the operator for logical AND in Java?', '`&&`'),
(demo_class_id, java_deck_id, 'Logical OR', 'What is the operator for logical OR in Java?', '`||`'),
(demo_class_id, java_deck_id, 'Logical NOT', 'What is the operator for logical NOT in Java?', '`!`'),
(demo_class_id, java_deck_id, 'If Statement', 'How do you write an if statement in Java?', '`if (condition) { }`'),
(demo_class_id, java_deck_id, 'If-Else Statement', 'How do you write an if-else statement in Java?', '`if (condition) { } else { }`'),
(demo_class_id, java_deck_id, 'Else If Statement', 'How do you write an else-if statement in Java?', '`if (a) { } else if (b) { }`'),
(demo_class_id, java_deck_id, 'For Loop', 'How do you write a for loop that counts from 0 to 9?', '`for (int i = 0; i < 10; i++) { }`'),
(demo_class_id, java_deck_id, 'While Loop', 'How do you write a while loop in Java?', '`while (condition) { }`'),
(demo_class_id, java_deck_id, 'Do-While Loop', 'How do you write a do-while loop in Java?', '`do { } while (condition);`'),
(demo_class_id, java_deck_id, 'Declare Array', 'How do you declare an array of 5 integers?', '`int[] arr = new int[5];`'),
(demo_class_id, java_deck_id, 'Access Array Element', 'How do you access the first element of an array arr?', '`arr[0]`'),
(demo_class_id, java_deck_id, 'Array Length', 'How do you get the length of an array arr?', '`arr.length`'),
(demo_class_id, java_deck_id, 'Define Method', 'How do you define a method that returns an int?', '`public int methodName() { }`'),
(demo_class_id, java_deck_id, 'Method with Parameters', 'How do you define a method with parameters?', '`public void methodName(int x, String y) { }`'),
(demo_class_id, java_deck_id, 'Return Value', 'How do you return a value from a method?', '`return value;`'),
(demo_class_id, java_deck_id, 'Call Method', 'How do you call a method named foo?', '`foo();`'),
(demo_class_id, java_deck_id, 'Define Class', 'How do you define a class named Dog?', '`public class Dog { }`'),
(demo_class_id, java_deck_id, 'Create Object', 'How do you create an object of class Dog?', '`Dog myDog = new Dog();`'),
(demo_class_id, java_deck_id, 'Constructor', 'How do you define a constructor in Java?', '`public ClassName() { }`'),
(demo_class_id, java_deck_id, 'Class Field', 'How do you define a field in a class?', '`private int age;`'),
(demo_class_id, java_deck_id, 'Access Field', 'How do you access a field age of object dog?', '`dog.age`'),
(demo_class_id, java_deck_id, 'Inheritance', 'How do you make class Dog inherit from Animal?', '`public class Dog extends Animal { }`'),
(demo_class_id, java_deck_id, 'Call Superclass Constructor', 'How do you call a superclass constructor?', '`super();`'),
(demo_class_id, java_deck_id, 'Override Method', 'How do you override a method?', '`@Override\npublic void methodName() { }`'),
(demo_class_id, java_deck_id, 'Define Interface', 'How do you define an interface?', '`public interface MyInterface { }`'),
(demo_class_id, java_deck_id, 'Implement Interface', 'How do you implement an interface?', '`public class MyClass implements MyInterface { }`'),
(demo_class_id, java_deck_id, 'Abstract Class', 'How do you define an abstract class?', '`public abstract class MyClass { }`'),
(demo_class_id, java_deck_id, 'Abstract Method', 'How do you define an abstract method?', '`public abstract void myMethod();`'),
(demo_class_id, java_deck_id, 'Declare Package', 'How do you declare a package at the top of a file?', '`package mypackage;`'),
(demo_class_id, java_deck_id, 'Import Class', 'How do you import a class from another package?', '`import package.ClassName;`'),
(demo_class_id, java_deck_id, 'Static Variable', 'How do you declare a static variable?', '`static int count;`'),
(demo_class_id, java_deck_id, 'Call Static Method', 'How do you call a static method?', '`ClassName.methodName();`'),
(demo_class_id, java_deck_id, 'Final Variable', 'What does the final keyword do for a variable?', 'Makes it a constant (cannot be changed)'),
(demo_class_id, java_deck_id, 'Final Method', 'What does the final keyword do for a method?', 'Prevents the method from being overridden'),
(demo_class_id, java_deck_id, 'Final Class', 'What does the final keyword do for a class?', 'Prevents the class from being subclassed'),
(demo_class_id, java_deck_id, 'Public Keyword', 'What does public mean in Java?', 'The member is accessible from any other class'),
(demo_class_id, java_deck_id, 'Private Keyword', 'What does private mean in Java?', 'The member is accessible only within its own class'),
(demo_class_id, java_deck_id, 'Protected Keyword', 'What does protected mean in Java?', 'The member is accessible within its package and subclasses'),
(demo_class_id, java_deck_id, 'This Keyword', 'What does this refer to in Java?', 'The current object'),
(demo_class_id, java_deck_id, 'Super Keyword', 'What does super refer to in Java?', 'The superclass of the current object'),
(demo_class_id, java_deck_id, 'Try-Catch', 'How do you handle exceptions in Java?', '`try { } catch (Exception e) { }`'),
(demo_class_id, java_deck_id, 'Throw Exception', 'How do you throw an exception?', '`throw new Exception("message");`'),
(demo_class_id, java_deck_id, 'Throws Clause', 'How do you declare a method that throws an exception?', '`public void myMethod() throws Exception { }`'),
(demo_class_id, java_deck_id, 'Try-Finally', 'How do you use a finally block?', '`try { } finally { }`'),
(demo_class_id, java_deck_id, 'Cast int to double', 'How do you cast an int to a double?', '`(double) myInt`'),
(demo_class_id, java_deck_id, 'Cast double to int', 'How do you cast a double to an int?', '`(int) myDouble`'),
(demo_class_id, java_deck_id, 'Wrapper Class for int', 'What is the wrapper class for int?', '`Integer`'),
(demo_class_id, java_deck_id, 'Wrapper Class for double', 'What is the wrapper class for double?', '`Double`'),
(demo_class_id, java_deck_id, 'Wrapper Class for boolean', 'What is the wrapper class for boolean?', '`Boolean`'),
(demo_class_id, java_deck_id, 'Wrapper Class for char', 'What is the wrapper class for char?', '`Character`'),
(demo_class_id, java_deck_id, 'Define Enum', 'How do you define an enum?', '`enum Color { RED, GREEN, BLUE }`'),
(demo_class_id, java_deck_id, 'Access Enum Value', 'How do you access an enum value?', '`Color.RED`'),
(demo_class_id, java_deck_id, 'Enhanced For Loop', 'How do you write an enhanced for loop?', '`for (int num : numbers) { }`'),
(demo_class_id, java_deck_id, 'Break Statement', 'What does break do in a loop?', 'Exits the current loop or switch'),
(demo_class_id, java_deck_id, 'Continue Statement', 'What does continue do in a loop?', 'Skips to the next iteration of the loop'),
(demo_class_id, java_deck_id, 'Return Statement', 'What does return do in a method?', 'Exits a method and optionally returns a value'),
(demo_class_id, java_deck_id, 'Null Keyword', 'What does null mean in Java?', 'No object or value assigned'),
(demo_class_id, java_deck_id, 'Instanceof Operator', 'What does instanceof do?', 'Checks if an object is an instance of a class'),
(demo_class_id, java_deck_id, 'Override toString', 'How do you override toString()?', '`public String toString() { return "something"; }`'),
(demo_class_id, java_deck_id, 'Create Scanner', 'How do you create a Scanner for input?', '`Scanner sc = new Scanner(System.in);`'),
(demo_class_id, java_deck_id, 'Scanner nextInt', 'How do you read an int using Scanner?', '`int x = sc.nextInt();`'),
(demo_class_id, java_deck_id, 'Scanner nextLine', 'How do you read a line using Scanner?', '`String line = sc.nextLine();`'),
(demo_class_id, java_deck_id, 'Math abs', 'How do you get the absolute value of x?', '`Math.abs(x)`'),
(demo_class_id, java_deck_id, 'Math max', 'How do you get the maximum of a and b?', '`Math.max(a, b)`'),
(demo_class_id, java_deck_id, 'Math min', 'How do you get the minimum of a and b?', '`Math.min(a, b)`'),
(demo_class_id, java_deck_id, 'Math random', 'How do you get a random number between 0.0 and 1.0?', '`Math.random()`'),
(demo_class_id, java_deck_id, 'System exit', 'How do you exit a Java program?', '`System.exit(0);`'),
(demo_class_id, java_deck_id, 'System currentTimeMillis', 'How do you get the current time in milliseconds?', '`System.currentTimeMillis()`'),
(demo_class_id, java_deck_id, 'StringBuilder', 'How do you create a StringBuilder?', '`StringBuilder sb = new StringBuilder();`'),
(demo_class_id, java_deck_id, 'StringBuilder append', 'How do you append to a StringBuilder?', '`sb.append("text");`'),
(demo_class_id, java_deck_id, 'StringBuilder toString', 'How do you convert a StringBuilder to a String?', '`sb.toString()`'),
(demo_class_id, java_deck_id, 'ArrayList', 'How do you create an ArrayList of Strings?', '`ArrayList<String> list = new ArrayList<>();`'),
(demo_class_id, java_deck_id, 'ArrayList add', 'How do you add an element to an ArrayList?', '`list.add("item");`'),
(demo_class_id, java_deck_id, 'ArrayList size', 'How do you get the size of an ArrayList?', '`list.size()`'),
(demo_class_id, java_deck_id, 'ArrayList get', 'How do you access the first element of an ArrayList?', '`list.get(0)`'),
(demo_class_id, java_deck_id, 'ArrayList remove', 'How do you remove an element from an ArrayList?', '`list.remove("item");`'),
(demo_class_id, java_deck_id, 'HashMap', 'How do you create a HashMap?', '`HashMap<KeyType, ValueType> map = new HashMap<>();`'),
(demo_class_id, java_deck_id, 'HashMap put', 'How do you put a value in a HashMap?', '`map.put(key, value);`'),
(demo_class_id, java_deck_id, 'HashMap get', 'How do you get a value from a HashMap?', '`map.get(key)`'),
(demo_class_id, java_deck_id, 'HashMap remove', 'How do you remove a value from a HashMap?', '`map.remove(key);`');

END $$;

-- More seed data for analytics testing

DO $$
DECLARE
    -- User IDs
    student_1_id uuid;
    student_2_id uuid;
    student_3_id uuid;
    student_4_id uuid;
    student_5_id uuid;
    student_6_id uuid;
    student_7_id uuid;
    student_8_id uuid;
    student_9_id uuid;
    student_10_id uuid;
    student_11_id uuid;
    student_12_id uuid;
    student_13_id uuid;
    student_14_id uuid;
    student_15_id uuid;
    student_16_id uuid;
    student_17_id uuid;
    student_18_id uuid;
    student_19_id uuid;
    student_20_id uuid;
    
    -- Deck IDs
    python_deck_id int8;
    sql_deck_id int8;
    web_dev_deck_id int8;

    -- Class ID
    demo_class_id int8 := 1;

    -- User counter for profile creation
    i int;
BEGIN
    -- Insert 20 new student users
    FOR i IN 1..20 LOOP
        EXECUTE format('
            INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_super_admin)
            VALUES (''00000000-0000-0000-0000-000000000000'', ''33333333-3333-3333-3333-%s'', ''authenticated'', ''authenticated'', ''student%s@pawtograder.com'', ''dummyhash'', NOW(), ''{}'', ''{}'', FALSE);
        ', lpad(i::text, 12, '0'), i);
    END LOOP;

    -- Update profiles for the new users. Assumes a trigger creates profiles and user_roles on user creation.
    FOR i IN 1..20 LOOP
        EXECUTE format('
            WITH user_and_profiles AS (
                SELECT
                    ur.private_profile_id,
                    ur.public_profile_id
                FROM
                    auth.users u
                JOIN
                    public.user_roles ur ON u.id = ur.user_id
                WHERE
                    u.email = ''student%s@pawtograder.com''
            )
            UPDATE public.profiles
            SET
                name = ''Student %s'',
                sortable_name = ''Student, %s'',
                short_name = ''Student %s''
            WHERE
                id IN (
                    (SELECT private_profile_id FROM user_and_profiles),
                    (SELECT public_profile_id FROM user_and_profiles)
                );
        ', i, i, i, i);
    END LOOP;
    
    -- Get student IDs
    SELECT id INTO student_1_id FROM auth.users WHERE email = 'student1@pawtograder.com';
    SELECT id INTO student_2_id FROM auth.users WHERE email = 'student2@pawtograder.com';
    SELECT id INTO student_3_id FROM auth.users WHERE email = 'student3@pawtograder.com';
    SELECT id INTO student_4_id FROM auth.users WHERE email = 'student4@pawtograder.com';
    SELECT id INTO student_5_id FROM auth.users WHERE email = 'student5@pawtograder.com';
    SELECT id INTO student_6_id FROM auth.users WHERE email = 'student6@pawtograder.com';
    SELECT id INTO student_7_id FROM auth.users WHERE email = 'student7@pawtograder.com';
    SELECT id INTO student_8_id FROM auth.users WHERE email = 'student8@pawtograder.com';
    SELECT id INTO student_9_id FROM auth.users WHERE email = 'student9@pawtograder.com';
    SELECT id INTO student_10_id FROM auth.users WHERE email = 'student10@pawtograder.com';
    SELECT id INTO student_11_id FROM auth.users WHERE email = 'student11@pawtograder.com';
    SELECT id INTO student_12_id FROM auth.users WHERE email = 'student12@pawtograder.com';
    SELECT id INTO student_13_id FROM auth.users WHERE email = 'student13@pawtograder.com';
    SELECT id INTO student_14_id FROM auth.users WHERE email = 'student14@pawtograder.com';
    SELECT id INTO student_15_id FROM auth.users WHERE email = 'student15@pawtograder.com';
    SELECT id INTO student_16_id FROM auth.users WHERE email = 'student16@pawtograder.com';
    SELECT id INTO student_17_id FROM auth.users WHERE email = 'student17@pawtograder.com';
    SELECT id INTO student_18_id FROM auth.users WHERE email = 'student18@pawtograder.com';
    SELECT id INTO student_19_id FROM auth.users WHERE email = 'student19@pawtograder.com';
    SELECT id INTO student_20_id FROM auth.users WHERE email = 'student20@pawtograder.com';

    -- Create Python Deck
    INSERT INTO public.flashcard_decks (class_id, creator_id, name, description)
    VALUES (demo_class_id, student_1_id, 'Python Basics', 'Core concepts of Python programming.')
    RETURNING id INTO python_deck_id;

    -- Add cards to Python Deck
    INSERT INTO public.flashcards (class_id, deck_id, title, prompt, answer, "order")
    VALUES
        (demo_class_id, python_deck_id, 'Python Variable', 'How do you create a variable in Python?', '`x = 5`', 1),
        (demo_class_id, python_deck_id, 'Python Function', 'How do you define a function in Python?', '`def my_function():`', 2),
        (demo_class_id, python_deck_id, 'Python List', 'How do you create a list in Python?', '`my_list = [1, 2, 3]`', 3),
        (demo_class_id, python_deck_id, 'Python For Loop', 'How do you write a for loop in Python?', '`for x in my_list:`', 4),
        (demo_class_id, python_deck_id, 'Python Dictionary', 'How do you create a dictionary?', '`my_dict = {"key": "value"}`', 5),
        (demo_class_id, python_deck_id, 'Python If Statement', 'How do you write an if statement?', '`if condition:`', 6),
        (demo_class_id, python_deck_id, 'Python Comment', 'How do you write a single-line comment?', '`# This is a comment`', 7),
        (demo_class_id, python_deck_id, 'Python String Length', 'How do you get the length of a string `s`?', '`len(s)`', 8),
        (demo_class_id, python_deck_id, 'Python Import', 'How do you import a module named `math`?', '`import math`', 9),
        (demo_class_id, python_deck_id, 'Python Class', 'How do you define a class?', '`class MyClass:`', 10);

    -- Create SQL Deck
    INSERT INTO public.flashcard_decks (class_id, creator_id, name, description)
    VALUES (demo_class_id, student_2_id, 'SQL Fundamentals', 'Learn the basics of SQL.')
    RETURNING id INTO sql_deck_id;

    -- Add cards to SQL Deck
    INSERT INTO public.flashcards (class_id, deck_id, title, prompt, answer, "order")
    VALUES
        (demo_class_id, sql_deck_id, 'SQL SELECT', 'What is the `SELECT` statement used for?', 'To query data from a database.', 1),
        (demo_class_id, sql_deck_id, 'SQL INSERT', 'What is the `INSERT INTO` statement used for?', 'To insert new records in a table.', 2),
        (demo_class_id, sql_deck_id, 'SQL UPDATE', 'What is the `UPDATE` statement used for?', 'To modify records in a table.', 3),
        (demo_class_id, sql_deck_id, 'SQL DELETE', 'What is the `DELETE` statement used for?', 'To delete records from a table.', 4),
        (demo_class_id, sql_deck_id, 'SQL WHERE', 'What is the `WHERE` clause used for?', 'To filter records.', 5),
        (demo_class_id, sql_deck_id, 'SQL JOIN', 'What is a `JOIN` clause used for?', 'To combine rows from two or more tables.', 6),
        (demo_class_id, sql_deck_id, 'SQL PRIMARY KEY', 'What is a `PRIMARY KEY`?', 'A constraint that uniquely identifies each record in a table.', 7),
        (demo_class_id, sql_deck_id, 'SQL FOREIGN KEY', 'What is a `FOREIGN KEY`?', 'A key used to link two tables together.', 8),
        (demo_class_id, sql_deck_id, 'SQL COUNT', 'What does `COUNT()` function do?', 'Returns the number of rows that matches a specified criteria.', 9),
        (demo_class_id, sql_deck_id, 'SQL ORDER BY', 'What is the `ORDER BY` keyword used for?', 'To sort the result-set in ascending or descending order.', 10);

    -- Create Web Dev Deck
    INSERT INTO public.flashcard_decks (class_id, creator_id, name, description)
    VALUES (demo_class_id, student_3_id, 'Web Development Basics', 'HTML, CSS, and JavaScript fundamentals.')
    RETURNING id INTO web_dev_deck_id;

    -- Add cards to Web Dev Deck
    INSERT INTO public.flashcards (class_id, deck_id, title, prompt, answer, "order")
    VALUES
        (demo_class_id, web_dev_deck_id, 'HTML', 'What does HTML stand for?', 'HyperText Markup Language', 1),
        (demo_class_id, web_dev_deck_id, 'CSS', 'What does CSS stand for?', 'Cascading Style Sheets', 2),
        (demo_class_id, web_dev_deck_id, 'JavaScript', 'What is JavaScript primarily used for?', 'To create dynamic and interactive web content.', 3),
        (demo_class_id, web_dev_deck_id, 'HTML Tag', 'What is an HTML tag?', 'The hidden keywords within a web page that define how your web browser must format and display the content.', 4),
        (demo_class_id, web_dev_deck_id, 'CSS Selector', 'What is a CSS selector?', 'A pattern to select the element(s) you want to style.', 5),
        (demo_class_id, web_dev_deck_id, 'JS Variable', 'How do you declare a variable in JavaScript?', 'Using `var`, `let`, or `const` keywords.', 6),
        (demo_class_id, web_dev_deck_id, 'HTML Link', 'How do you create a hyperlink in HTML?', '`<a href="url">link text</a>`', 7),
        (demo_class_id, web_dev_deck_id, 'CSS Color', 'How do you set the text color in CSS?', '`color: blue;`', 8),
        (demo_class_id, web_dev_deck_id, 'JS Function', 'How do you define a function in JavaScript?', '`function myFunction() {}`', 9),
        (demo_class_id, web_dev_deck_id, 'HTML Image', 'How do you insert an image in HTML?', '`<img src="image.jpg" alt="description">`', 10);

    -- Generate a large amount of interaction logs
    DECLARE
        student_ids uuid[] := ARRAY[student_1_id, student_2_id, student_3_id, student_4_id, student_5_id, student_6_id, student_7_id, student_8_id, student_9_id, student_10_id, student_11_id, student_12_id, student_13_id, student_14_id, student_15_id, student_16_id, student_17_id, student_18_id, student_19_id, student_20_id];
        deck_ids int8[] := ARRAY(SELECT id FROM public.flashcard_decks WHERE class_id = demo_class_id);
        card_ids int[];
        s_id uuid;
        d_id int8;
        c_id int;
        action public.flashcard_actions;
        duration int;
        r int;
    BEGIN
        FOREACH d_id IN ARRAY deck_ids
        LOOP
            -- Get card IDs for the current deck
            card_ids := ARRAY(SELECT id FROM public.flashcards WHERE deck_id = d_id);
            
            -- Each student interacts with each deck
            FOREACH s_id IN ARRAY student_ids
            LOOP
                -- Log deck_viewed action
                INSERT INTO public.flashcard_interaction_logs (class_id, deck_id, student_id, action, duration_on_card_ms)
                VALUES (demo_class_id, d_id, s_id, 'deck_viewed', (random() * 1000 + 500)::int);

                -- Each student interacts with some cards in the deck
                FOR r IN 1..((random() * (array_length(card_ids, 1) - 1) + 1)::int)
                LOOP
                    c_id := card_ids[(random() * (array_length(card_ids, 1) - 1) + 1)::int];
                    
                    -- card_prompt_viewed
                    duration := (random() * 5000 + 1000)::int;
                    INSERT INTO public.flashcard_interaction_logs (class_id, deck_id, card_id, student_id, action, duration_on_card_ms)
                    VALUES (demo_class_id, d_id, c_id, s_id, 'card_prompt_viewed', duration);
                    
                    -- card_answer_viewed
                    duration := (random() * 8000 + 2000)::int;
                    INSERT INTO public.flashcard_interaction_logs (class_id, deck_id, card_id, student_id, action, duration_on_card_ms)
                    VALUES (demo_class_id, d_id, c_id, s_id, 'card_answer_viewed', duration);

                    -- card_marked_got_it or card_marked_keep_trying
                    duration := (random() * 3000 + 1000)::int;
                    IF random() > 0.3 THEN
                        action := 'card_marked_got_it';
                    ELSE
                        action := 'card_marked_keep_trying';
                    END IF;
                    INSERT INTO public.flashcard_interaction_logs (class_id, deck_id, card_id, student_id, action, duration_on_card_ms)
                    VALUES (demo_class_id, d_id, c_id, s_id, action, duration);
                    
                    -- card_returned_to_deck (less frequent)
                    IF random() > 0.8 THEN
                         INSERT INTO public.flashcard_interaction_logs (class_id, deck_id, card_id, student_id, action, duration_on_card_ms)
                         VALUES (demo_class_id, d_id, c_id, s_id, 'card_returned_to_deck', 0);
                    END IF;
                END LOOP;
                
                -- deck_progress_reset_all (occasional)
                IF random() > 0.9 THEN
                    INSERT INTO public.flashcard_interaction_logs (class_id, deck_id, student_id, action, duration_on_card_ms)
                    VALUES (demo_class_id, d_id, s_id, 'deck_progress_reset_all', 0);
                END IF;

            END LOOP;
        END LOOP;
    END;
END $$;

-- Seed data for Help Queue and Office Hours feature
DO $$
DECLARE
    demo_class_id int8 := 1;
    text_queue_id int8;
    video_queue_id int8;
    inperson_queue_id int8;
    debugging_template_id int8;
    concept_template_id int8;
    student_private_profile_ids uuid[];
    student_priv uuid;
    submission_file_sample int8;
    i int;
    help_req_id int8;
    first_msg_id int8;
BEGIN
    ------------------------------------------------------------------
    -- Create diverse help queues ------------------------------------
    ------------------------------------------------------------------
    INSERT INTO public.help_queues (name, description, class_id, available, depth, queue_type, color)
    VALUES ('General Text Queue', 'Text-based help requests handled asynchronously.', demo_class_id, TRUE, 0, 'text', '#1E90FF')
    RETURNING id INTO text_queue_id;

    INSERT INTO public.help_queues (name, description, class_id, available, depth, queue_type, color)
    VALUES ('Office Hours Video Queue', 'Live video queue for real-time debugging sessions.', demo_class_id, TRUE, 0, 'video', '#32CD32')
    RETURNING id INTO video_queue_id;

    INSERT INTO public.help_queues (name, description, class_id, available, depth, queue_type, color)
    VALUES ('In-Person Queue', 'Queue for students physically present in the lab.', demo_class_id, TRUE, 0, 'in_person', '#FFA500')
    RETURNING id INTO inperson_queue_id;

    ------------------------------------------------------------------
    -- Create help-request templates ---------------------------------
    ------------------------------------------------------------------
    INSERT INTO public.help_request_templates (class_id, created_by_id, name, description, template_content, category, is_active)
    VALUES (
        demo_class_id,
        '11111111-1111-1111-1111-111111111111',
        'Debugging Template',
        'Standard debugging information',
        CONCAT('1. Expected behaviour vs. actual behaviour', CHR(10), '2. Steps to reproduce', CHR(10), '3. Relevant code snippets'),
        'Debugging',
        TRUE
    ) RETURNING id INTO debugging_template_id;

    INSERT INTO public.help_request_templates (class_id, created_by_id, name, description, template_content, category, is_active)
    VALUES (
        demo_class_id,
        '11111111-1111-1111-1111-111111111111',
        'Concept Question Template',
        'Template for conceptual questions',
        CONCAT('1. Concept you are struggling with', CHR(10), '2. Your current understanding', CHR(10), '3. Resources already consulted'),
        'Concept',
        TRUE
    ) RETURNING id INTO concept_template_id;

    ------------------------------------------------------------------
    -- Assign instructor Eva to queues as on-duty TA ------------------
    ------------------------------------------------------------------
    INSERT INTO public.help_queue_assignments (help_queue_id, ta_profile_id, class_id, started_at, is_active, max_concurrent_students)
    VALUES
        (text_queue_id, (SELECT private_profile_id FROM public.user_roles WHERE user_id='11111111-1111-1111-1111-111111111111'), demo_class_id, now() - interval '2 hours', TRUE, 6),
        (video_queue_id, (SELECT private_profile_id FROM public.user_roles WHERE user_id='11111111-1111-1111-1111-111111111111'), demo_class_id, now() - interval '90 minutes', TRUE, 4),
        (inperson_queue_id, (SELECT private_profile_id FROM public.user_roles WHERE user_id='11111111-1111-1111-1111-111111111111'), demo_class_id, now() - interval '30 minutes', TRUE, 12);

    ------------------------------------------------------------------
    -- Get a sample submission file reference ------------------------
    ------------------------------------------------------------------
    SELECT id INTO submission_file_sample FROM public.submission_files LIMIT 1;

    ------------------------------------------------------------------
    -- Collect private profile IDs for first 10 seeded students -------
    ------------------------------------------------------------------
    student_private_profile_ids := ARRAY(
        SELECT private_profile_id
        FROM public.user_roles
        WHERE user_id IN (
            SELECT id FROM auth.users WHERE email LIKE 'student%' ORDER BY email LIMIT 10
        )
    );

    ------------------------------------------------------------------
    -- Generate diverse help requests --------------------------------
    ------------------------------------------------------------------
    FOR i IN 1..array_length(student_private_profile_ids, 1) LOOP
        student_priv := student_private_profile_ids[i];

        -- Create help request (alternate queue & privacy)
        INSERT INTO public.help_requests (
            class_id,
            request,
            help_queue,
            is_private,
            location_type,
            template_id,
            status,
            created_by
        ) VALUES (
            demo_class_id,
            format('Help request #%s: My program crashes on edge cases.', i),
            CASE WHEN i % 3 = 1 THEN text_queue_id WHEN i % 3 = 2 THEN video_queue_id ELSE inperson_queue_id END,
            (i % 2 = 0),
            CASE 
                WHEN i % 3 = 1 THEN 'remote'::public.location_type
                WHEN i % 3 = 2 THEN 'remote'::public.location_type
                ELSE 'in_person'::public.location_type
            END,
            CASE WHEN i % 2 = 0 THEN debugging_template_id ELSE concept_template_id END,
            'open',
            student_priv
        ) RETURNING id INTO help_req_id;

        -- Add student to help request via the new many-to-many table
        INSERT INTO public.help_request_students (
            help_request_id,
            profile_id,
            class_id
        ) VALUES (
            help_req_id,
            student_priv,
            demo_class_id
        );

        -- Optional file reference for even numbered requests
        IF i % 2 = 0 THEN
            INSERT INTO public.help_request_file_references (
                help_request_id,
                class_id,
                submission_file_id,
                submission_id,
                line_number,
                assignment_id
            ) VALUES (
                help_req_id,
                demo_class_id,
                submission_file_sample,
                (SELECT submission_id FROM public.submission_files WHERE id = submission_file_sample),
                42,
                1
            );
        END IF;

        -- Initial student message
        INSERT INTO public.help_request_messages (
            help_request_id,
            class_id,
            author,
            message,
            instructors_only
        ) VALUES (
            help_req_id,
            demo_class_id,
            student_priv,
            'Here are the steps I have tried so far...',
            FALSE
        ) RETURNING id INTO first_msg_id;

        -- TA reply
        INSERT INTO public.help_request_messages (
            help_request_id,
            class_id,
            author,
            message,
            instructors_only,
            reply_to_message_id
        ) VALUES (
            help_req_id,
            demo_class_id,
            (SELECT private_profile_id FROM public.user_roles WHERE user_id='11111111-1111-1111-1111-111111111111'),
            'Thanks for the details — let''s debug this together.',
            FALSE,
            first_msg_id
        );

        -- Log student activity
        INSERT INTO public.student_help_activity (
            class_id,
            help_request_id,
            student_profile_id,
            activity_type,
            activity_description
        ) VALUES (
            demo_class_id,
            help_req_id,
            student_priv,
            'request_created',
            'Student created a new help request via web UI.'
        );
    END LOOP;

    ------------------------------------------------------------------
    -- Create some group help requests to demonstrate many-to-many ---
    ------------------------------------------------------------------
    
    -- Create a group help request with multiple students
    INSERT INTO public.help_requests (
        class_id,
        request,
        help_queue,
        is_private,
        location_type,
        status,
        created_by
    ) VALUES (
        demo_class_id,
        'Group project debugging session - need help with merge conflicts and integration issues.',
        video_queue_id,
        FALSE,
        'remote',
        'open',
        student_private_profile_ids[1]
    ) RETURNING id INTO help_req_id;

    -- Add multiple students to this group help request
    FOR i IN 1..3 LOOP
        INSERT INTO public.help_request_students (
            help_request_id,
            profile_id,
            class_id
        ) VALUES (
            help_req_id,
            student_private_profile_ids[i],
            demo_class_id
        );
    END LOOP;

    -- Group message from first student
    INSERT INTO public.help_request_messages (
        help_request_id,
        class_id,
        author,
        message,
        instructors_only
    ) VALUES (
        help_req_id,
        demo_class_id,
        student_private_profile_ids[1],
        'We are working on our group project and ran into some Git merge conflicts. Can we get help during office hours?',
        FALSE
    );

    -- Another group member adds details
    INSERT INTO public.help_request_messages (
        help_request_id,
        class_id,
        author,
        message,
        instructors_only
    ) VALUES (
        help_req_id,
        demo_class_id,
        student_private_profile_ids[2],
        'Also having issues with our database integration tests failing after the merge.',
        FALSE
    );

    ------------------------------------------------------------------
    -- Example moderation action -------------------------------------
    ------------------------------------------------------------------
    INSERT INTO public.help_request_moderation (
        help_request_id,
        student_profile_id,
        moderator_profile_id,
        class_id,
        action_type,
        reason,
        duration_minutes,
        is_permanent
    ) VALUES (
        (SELECT id FROM public.help_requests ORDER BY created_at DESC LIMIT 1),
        student_private_profile_ids[4],
        (SELECT private_profile_id FROM public.user_roles WHERE user_id='11111111-1111-1111-1111-111111111111'),
        demo_class_id,
        'temporary_ban',
        'Inappropriate language detected in the chat.',
        60,
        FALSE
    );
END $$;
