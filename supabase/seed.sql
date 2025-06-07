INSERT into public.classes(name, semester, slug, is_demo, github_org, time_zone) VALUES ('Demo Class', 20281, 'demo-class', true, 'autograder-dev', 'UTC');

DO $$
DECLARE 
    alyssa_self_review_id int8;
BEGIN
INSERT INTO public.assignment_self_review_settings(id, enabled, deadline_offset, allow_early, class_id)
  VALUES (1, true, 2, true, 1) RETURNING id into alyssa_self_review_id;
    
INSERT INTO public.assignments (
  id,
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
) VALUES (1,
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
  alyssa_self_review_id
);

END $$;

insert into help_queues (name, description, class_id, available, depth)
  VALUES ('demo','demo description', 1, TRUE, 0);

INSERT INTO "public"."name_generation_words" ("id", "word", "is_noun", "is_adjective") VALUES ('1', 'able', 'false', 'true'), ('2', 'action', 'false', 'true'), ('3', 'active', 'false', 'true'), ('4', 'actual', 'false', 'true'), ('5', 'adept', 'false', 'true'), ('6', 'adored', 'false', 'true'), ('7', 'adroit', 'false', 'true'), ('8', 'affectionate', 'false', 'true'), ('9', 'agile', 'false', 'true'), ('10', 'airy', 'false', 'true'), ('11', 'alert', 'false', 'true'), ('12', 'alive', 'false', 'true'), ('13', 'alter', 'false', 'true'), ('14', 'amiable', 'false', 'true'), ('15', 'ample', 'false', 'true'), ('16', 'and', 'false', 'true'), ('17', 'anima', 'false', 'true'), ('18', 'apt', 'false', 'true'), ('19', 'ardent', 'false', 'true'), ('20', 'are', 'false', 'true'), ('21', 'astute', 'false', 'true'), ('22', 'august', 'false', 'true'), ('23', 'avid', 'false', 'true'), ('24', 'awake', 'false', 'true'), ('25', 'aware', 'false', 'true'), ('26', 'balmy', 'false', 'true'), ('27', 'benevolent', 'false', 'true'), ('28', 'big', 'false', 'true'), ('29', 'billowing', 'false', 'true'), ('30', 'blessed', 'false', 'true'), ('31', 'bold', 'false', 'true'), ('32', 'boss', 'false', 'true'), ('33', 'brainy', 'false', 'true'), ('34', 'brave', 'false', 'true'), ('35', 'brawny', 'false', 'true'), ('36', 'breezy', 'false', 'true'), ('37', 'brief', 'false', 'true'), ('38', 'bright', 'false', 'true'), ('39', 'brisk', 'false', 'true'), ('40', 'busy', 'false', 'true'), ('41', 'calm', 'false', 'true'), ('42', 'can', 'false', 'true'), ('43', 'canny', 'false', 'true'), ('44', 'cared', 'false', 'true'), ('45', 'caring', 'false', 'true'), ('46', 'casual', 'false', 'true'), ('47', 'celestial', 'false', 'true'), ('48', 'charming', 'false', 'true'), ('49', 'chic', 'false', 'true'), ('50', 'chief', 'false', 'true'), ('51', 'choice', 'false', 'true'), ('52', 'chosen', 'false', 'true'), ('53', 'chummy', 'false', 'true'), ('54', 'civic', 'false', 'true'), ('55', 'civil', 'false', 'true'), ('56', 'classy', 'false', 'true'), ('57', 'clean', 'false', 'true'), ('58', 'clear', 'false', 'true'), ('59', 'clever', 'false', 'true'), ('60', 'close', 'false', 'true'), ('61', 'cogent', 'false', 'true'), ('62', 'composed', 'false', 'true'), ('63', 'cool', 'false', 'true'), ('64', 'cosmic', 'false', 'true'), ('65', 'cozy', 'false', 'true'), ('66', 'cuddly', 'false', 'true'), ('67', 'cute', 'false', 'true'), ('68', 'dainty', 'false', 'true'), ('69', 'dandy', 'false', 'true'), ('70', 'dapper', 'false', 'true'), ('71', 'daring', 'false', 'true'), ('72', 'dear', 'false', 'true'), ('73', 'decent', 'false', 'true'), ('74', 'deep', 'false', 'true'), ('75', 'deft', 'false', 'true'), ('76', 'deluxe', 'false', 'true'), ('77', 'devout', 'false', 'true'), ('78', 'direct', 'false', 'true'), ('79', 'divine', 'false', 'true'), ('80', 'doted', 'false', 'true'), ('81', 'doting', 'false', 'true'), ('82', 'dreamy', 'false', 'true'), ('83', 'driven', 'false', 'true'), ('84', 'dry', 'false', 'true'), ('85', 'earthy', 'false', 'true'), ('86', 'easy', 'false', 'true'), ('87', 'elated', 'false', 'true'), ('88', 'energized', 'false', 'true'), ('89', 'enigmatic', 'false', 'true'), ('90', 'equal', 'false', 'true'), ('91', 'exact', 'false', 'true'), ('92', 'exotic', 'false', 'true'), ('93', 'expert', 'false', 'true'), ('94', 'exuberant', 'false', 'true'), ('95', 'fair', 'false', 'true'), ('96', 'famed', 'false', 'true'), ('97', 'famous', 'false', 'true'), ('98', 'fancy', 'false', 'true'), ('99', 'fast', 'false', 'true'), ('100', 'fiery', 'false', 'true'), ('101', 'fine', 'false', 'true'), ('102', 'fit', 'false', 'true'), ('103', 'flashy', 'false', 'true'), ('104', 'fleek', 'false', 'true'), ('105', 'fleet', 'false', 'true'), ('106', 'flowing', 'false', 'true'), ('107', 'fluent', 'false', 'true'), ('108', 'fluffy', 'false', 'true'), ('109', 'fluttering', 'false', 'true'), ('110', 'flying', 'false', 'true'), ('111', 'fond', 'false', 'true'), ('112', 'frank', 'false', 'true'), ('113', 'free', 'false', 'true'), ('114', 'fresh', 'false', 'true'), ('115', 'full', 'false', 'true'), ('116', 'fun', 'false', 'true'), ('117', 'funny', 'false', 'true'), ('118', 'fuscia', 'false', 'true'), ('119', 'genial', 'false', 'true'), ('120', 'gentle', 'false', 'true'), ('121', 'giddy', 'false', 'true'), ('122', 'gifted', 'false', 'true'), ('123', 'giving', 'false', 'true'), ('124', 'glad', 'false', 'true'), ('125', 'gnarly', 'false', 'true'), ('126', 'gold', 'false', 'true'), ('127', 'golden', 'false', 'true'), ('128', 'good', 'false', 'true'), ('129', 'goodly', 'false', 'true'), ('130', 'graceful', 'false', 'true'), ('131', 'grand', 'false', 'true'), ('132', 'great', 'false', 'true'), ('133', 'green', 'false', 'true'), ('134', 'groovy', 'false', 'true'), ('135', 'guided', 'false', 'true'), ('136', 'gutsy', 'false', 'true'), ('137', 'haloed', 'false', 'true'), ('138', 'happy', 'false', 'true'), ('139', 'hardy', 'false', 'true'), ('140', 'harmonious', 'false', 'true'), ('141', 'hearty', 'false', 'true'), ('142', 'heroic', 'false', 'true'), ('143', 'high', 'false', 'true'), ('144', 'hip', 'false', 'true'), ('145', 'hollow', 'false', 'true'), ('146', 'holy', 'false', 'true'), ('147', 'honest', 'false', 'true'), ('148', 'huge', 'false', 'true'), ('149', 'humane', 'false', 'true'), ('150', 'humble', 'false', 'true'), ('151', 'hunky', 'false', 'true'), ('152', 'icy', 'false', 'true'), ('153', 'ideal', 'false', 'true'), ('154', 'immune', 'false', 'true'), ('155', 'indigo', 'false', 'true'), ('156', 'inquisitive', 'false', 'true'), ('157', 'jazzed', 'false', 'true'), ('158', 'jazzy', 'false', 'true'), ('159', 'jolly', 'false', 'true'), ('160', 'jovial', 'false', 'true'), ('161', 'joyful', 'false', 'true'), ('162', 'joyous', 'false', 'true'), ('163', 'jubilant', 'false', 'true'), ('164', 'juicy', 'false', 'true'), ('165', 'just', 'false', 'true'), ('166', 'keen', 'false', 'true'), ('167', 'khaki', 'false', 'true'), ('168', 'kind', 'false', 'true'), ('169', 'kingly', 'false', 'true'), ('170', 'large', 'false', 'true'), ('171', 'lavish', 'false', 'true'), ('172', 'lawful', 'false', 'true'), ('173', 'left', 'false', 'true'), ('174', 'legal', 'false', 'true'), ('175', 'legit', 'false', 'true'), ('176', 'light', 'false', 'true'), ('177', 'like', 'false', 'true'), ('178', 'liked', 'false', 'true'), ('179', 'likely', 'false', 'true'), ('180', 'limber', 'false', 'true'), ('181', 'limitless', 'false', 'true'), ('182', 'lively', 'false', 'true'), ('183', 'loved', 'false', 'true'), ('184', 'lovely', 'false', 'true'), ('185', 'loyal', 'false', 'true'), ('186', 'lucid', 'false', 'true'), ('187', 'lucky', 'false', 'true'), ('188', 'lush', 'false', 'true'), ('189', 'main', 'false', 'true'), ('190', 'major', 'false', 'true'), ('191', 'master', 'false', 'true'), ('192', 'mature', 'false', 'true'), ('193', 'max', 'false', 'true'), ('194', 'maxed', 'false', 'true'), ('195', 'mellow', 'false', 'true'), ('196', 'merciful', 'false', 'true'), ('197', 'merry', 'false', 'true'), ('198', 'mighty', 'false', 'true'), ('199', 'mint', 'false', 'true'), ('200', 'mirthful', 'false', 'true'), ('201', 'modern', 'false', 'true'), ('202', 'modest', 'false', 'true'), ('203', 'money', 'false', 'true'), ('204', 'moonlit', 'false', 'true'), ('205', 'moral', 'false', 'true'), ('206', 'moving', 'false', 'true'), ('207', 'mucho', 'false', 'true'), ('208', 'mutual', 'false', 'true'), ('209', 'mysterious', 'false', 'true'), ('210', 'native', 'false', 'true'), ('211', 'natural', 'false', 'true'), ('212', 'near', 'false', 'true'), ('213', 'neat', 'false', 'true'), ('214', 'needed', 'false', 'true'), ('215', 'new', 'false', 'true'), ('216', 'nice', 'false', 'true'), ('217', 'nifty', 'false', 'true'), ('218', 'nimble', 'false', 'true'), ('219', 'noble', 'false', 'true'), ('220', 'normal', 'false', 'true'), ('221', 'noted', 'false', 'true'), ('222', 'novel', 'false', 'true'), ('223', 'okay', 'false', 'true'), ('224', 'open', 'false', 'true'), ('225', 'outrageous', 'false', 'true'), ('226', 'overt', 'false', 'true'), ('227', 'pacific', 'false', 'true'), ('228', 'parched', 'false', 'true'), ('229', 'peachy', 'false', 'true'), ('230', 'peppy', 'false', 'true'), ('231', 'pithy', 'false', 'true'), ('232', 'placid', 'false', 'true'), ('233', 'pleasant', 'false', 'true'), ('234', 'plucky', 'false', 'true'), ('235', 'plum', 'false', 'true'), ('236', 'poetic', 'false', 'true'), ('237', 'poised', 'false', 'true'), ('238', 'polite', 'false', 'true'), ('239', 'posh', 'false', 'true'), ('240', 'potent', 'false', 'true'), ('241', 'pretty', 'false', 'true'), ('242', 'prime', 'false', 'true'), ('243', 'primo', 'false', 'true'), ('244', 'prized', 'false', 'true'), ('245', 'pro', 'false', 'true'), ('246', 'prompt', 'false', 'true'), ('247', 'proper', 'false', 'true'), ('248', 'proud', 'false', 'true'), ('249', 'pumped', 'false', 'true'), ('250', 'punchy', 'false', 'true'), ('251', 'pure', 'false', 'true'), ('252', 'purring', 'false', 'true'), ('253', 'quaint', 'false', 'true'), ('254', 'quick', 'false', 'true'), ('255', 'quiet', 'false', 'true'), ('256', 'rad', 'false', 'true'), ('257', 'radioactive', 'false', 'true'), ('258', 'rapid', 'false', 'true'), ('259', 'rare', 'false', 'true'), ('260', 'ready', 'false', 'true'), ('261', 'real', 'false', 'true'), ('262', 'regal', 'false', 'true'), ('263', 'resilient', 'false', 'true'), ('264', 'rich', 'false', 'true'), ('265', 'right', 'false', 'true'), ('266', 'robust', 'false', 'true'), ('267', 'rooted', 'false', 'true'), ('268', 'rosy', 'false', 'true'), ('269', 'rugged', 'false', 'true'), ('270', 'safe', 'false', 'true'), ('271', 'sassy', 'false', 'true'), ('272', 'saucy', 'false', 'true'), ('273', 'savvy', 'false', 'true'), ('274', 'scenic', 'false', 'true'), ('275', 'secret', 'false', 'true'), ('276', 'seemly', 'false', 'true'), ('277', 'serene', 'false', 'true'), ('278', 'sharp', 'false', 'true'), ('279', 'showy', 'false', 'true'), ('280', 'shrewd', 'false', 'true'), ('281', 'simple', 'false', 'true'), ('282', 'sleek', 'false', 'true'), ('283', 'slick', 'false', 'true'), ('284', 'smart', 'false', 'true'), ('285', 'smiley', 'false', 'true'), ('286', 'smooth', 'false', 'true'), ('287', 'snappy', 'false', 'true'), ('288', 'snazzy', 'false', 'true'), ('289', 'snowy', 'false', 'true'), ('290', 'snugly', 'false', 'true'), ('291', 'social', 'false', 'true'), ('292', 'sole', 'false', 'true'), ('293', 'solitary', 'false', 'true'), ('294', 'sound', 'false', 'true'), ('295', 'spacial', 'false', 'true'), ('296', 'spicy', 'false', 'true'), ('297', 'spiffy', 'false', 'true'), ('298', 'spry', 'false', 'true'), ('299', 'stable', 'false', 'true'), ('300', 'star', 'false', 'true'), ('301', 'stark', 'false', 'true'), ('302', 'steady', 'false', 'true'), ('303', 'stoic', 'false', 'true'), ('304', 'strong', 'false', 'true'), ('305', 'stunning', 'false', 'true'), ('306', 'sturdy', 'false', 'true'), ('307', 'suave', 'false', 'true'), ('308', 'subtle', 'false', 'true'), ('309', 'sunny', 'false', 'true'), ('310', 'sunset', 'false', 'true'), ('311', 'super', 'false', 'true'), ('312', 'superb', 'false', 'true'), ('313', 'sure', 'false', 'true'), ('314', 'swank', 'false', 'true'), ('315', 'sweet', 'false', 'true'), ('316', 'swell', 'false', 'true'), ('317', 'swift', 'false', 'true'), ('318', 'talented', 'false', 'true'), ('319', 'teal', 'false', 'true'), ('320', 'tidy', 'false', 'true'), ('321', 'timely', 'false', 'true'), ('322', 'touted', 'false', 'true'), ('323', 'tranquil', 'false', 'true'), ('324', 'trim', 'false', 'true'), ('325', 'tropical', 'false', 'true'), ('326', 'TRUE', 'false', 'true'), ('327', 'trusty', 'false', 'true'), ('328', 'undisturbed', 'false', 'true'), ('329', 'unique', 'false', 'true'), ('330', 'united', 'false', 'true'), ('331', 'unsightly', 'false', 'true'), ('332', 'unwavering', 'false', 'true'), ('333', 'upbeat', 'false', 'true'), ('334', 'uplifting', 'false', 'true'), ('335', 'urbane', 'false', 'true'), ('336', 'usable', 'false', 'true'), ('337', 'useful', 'false', 'true'), ('338', 'utmost', 'false', 'true'), ('339', 'valid', 'false', 'true'), ('340', 'vast', 'false', 'true'), ('341', 'vestal', 'false', 'true'), ('342', 'viable', 'false', 'true'), ('343', 'vital', 'false', 'true'), ('344', 'vivid', 'false', 'true'), ('345', 'vocal', 'false', 'true'), ('346', 'vogue', 'false', 'true'), ('347', 'volant', 'false', 'true'), ('348', 'wandering', 'false', 'true'), ('349', 'wanted', 'false', 'true'), ('350', 'warm', 'false', 'true'), ('351', 'wealthy', 'false', 'true'), ('352', 'whispering', 'false', 'true'), ('353', 'whole', 'false', 'true'), ('354', 'winged', 'false', 'true'), ('355', 'wired', 'false', 'true'), ('356', 'wise', 'false', 'true'), ('357', 'witty', 'false', 'true'), ('358', 'wooden', 'false', 'true'), ('359', 'worthy', 'false', 'true'), ('360', 'zealous', 'false', 'true'), ('361', 'abyss', 'true', 'false'), ('362', 'animal', 'true', 'false'), ('363', 'apple', 'true', 'false'), ('364', 'atoll', 'true', 'false'), ('365', 'aurora', 'true', 'false'), ('366', 'autumn', 'true', 'false'), ('367', 'bacon', 'true', 'false'), ('368', 'badlands', 'true', 'false'), ('369', 'ball', 'true', 'false'), ('370', 'banana', 'true', 'false'), ('371', 'bath', 'true', 'false'), ('372', 'beach', 'true', 'false'), ('373', 'bear', 'true', 'false'), ('374', 'bed', 'true', 'false'), ('375', 'bee', 'true', 'false'), ('376', 'bike', 'true', 'false'), ('377', 'bird', 'true', 'false'), ('378', 'boat', 'true', 'false'), ('379', 'book', 'true', 'false'), ('380', 'bowl', 'true', 'false'), ('381', 'branch', 'true', 'false'), ('382', 'bread', 'true', 'false'), ('383', 'breeze', 'true', 'false'), ('384', 'briars', 'true', 'false'), ('385', 'brook', 'true', 'false'), ('386', 'brush', 'true', 'false'), ('387', 'bunny', 'true', 'false'), ('388', 'candy', 'true', 'false'), ('389', 'canopy', 'true', 'false'), ('390', 'canyon', 'true', 'false'), ('391', 'car', 'true', 'false'), ('392', 'cat', 'true', 'false'), ('393', 'cave', 'true', 'false'), ('394', 'cavern', 'true', 'false'), ('395', 'cereal', 'true', 'false'), ('396', 'chair', 'true', 'false'), ('397', 'chasm', 'true', 'false'), ('398', 'chip', 'true', 'false'), ('399', 'cliff', 'true', 'false'), ('400', 'coal', 'true', 'false'), ('401', 'coast', 'true', 'false'), ('402', 'cookie', 'true', 'false'), ('403', 'cove', 'true', 'false'), ('404', 'cow', 'true', 'false'), ('405', 'crater', 'true', 'false'), ('406', 'creek', 'true', 'false'), ('407', 'darkness', 'true', 'false'), ('408', 'dawn', 'true', 'false'), ('409', 'desert', 'true', 'false'), ('410', 'dew', 'true', 'false'), ('411', 'dog', 'true', 'false'), ('412', 'door', 'true', 'false'), ('413', 'dove', 'true', 'false'), ('414', 'drylands', 'true', 'false'), ('415', 'duck', 'true', 'false'), ('416', 'dusk', 'true', 'false'), ('417', 'earth', 'true', 'false'), ('418', 'fall', 'true', 'false'), ('419', 'farm', 'true', 'false'), ('420', 'fern', 'true', 'false'), ('421', 'field', 'true', 'false'), ('422', 'firefly', 'true', 'false'), ('423', 'fish', 'true', 'false'), ('424', 'fjord', 'true', 'false'), ('425', 'flood', 'true', 'false'), ('426', 'flower', 'true', 'false'), ('427', 'flowers', 'true', 'false'), ('428', 'fog', 'true', 'false'), ('429', 'foliage', 'true', 'false'), ('430', 'forest', 'true', 'false'), ('431', 'freeze', 'true', 'false'), ('432', 'frog', 'true', 'false'), ('433', 'fu', 'true', 'false'), ('434', 'galaxy', 'true', 'false'), ('435', 'garden', 'true', 'false'), ('436', 'geyser', 'true', 'false'), ('437', 'gift', 'true', 'false'), ('438', 'glass', 'true', 'false'), ('439', 'grove', 'true', 'false'), ('440', 'guide', 'true', 'false'), ('441', 'guru', 'true', 'false'), ('442', 'hat', 'true', 'false'), ('443', 'hug', 'true', 'false'), ('444', 'hero', 'true', 'false'), ('445', 'hill', 'true', 'false'), ('446', 'horse', 'true', 'false'), ('447', 'house', 'true', 'false'), ('448', 'hurricane', 'true', 'false'), ('449', 'ice', 'true', 'false'), ('450', 'iceberg', 'true', 'false'), ('451', 'island', 'true', 'false'), ('452', 'juice', 'true', 'false'), ('453', 'lagoon', 'true', 'false'), ('454', 'lake', 'true', 'false'), ('455', 'land', 'true', 'false'), ('456', 'lawn', 'true', 'false'), ('457', 'leaf', 'true', 'false'), ('458', 'leaves', 'true', 'false'), ('459', 'light', 'true', 'false'), ('460', 'lion', 'true', 'false'), ('461', 'marsh', 'true', 'false'), ('462', 'meadow', 'true', 'false'), ('463', 'milk', 'true', 'false'), ('464', 'mist', 'true', 'false'), ('465', 'moon', 'true', 'false'), ('466', 'moss', 'true', 'false'), ('467', 'mountain', 'true', 'false'), ('468', 'mouse', 'true', 'false'), ('469', 'nature', 'true', 'false'), ('470', 'oasis', 'true', 'false'), ('471', 'ocean', 'true', 'false'), ('472', 'pants', 'true', 'false'), ('473', 'peak', 'true', 'false'), ('474', 'pebble', 'true', 'false'), ('475', 'pine', 'true', 'false'), ('476', 'pilot', 'true', 'false'), ('477', 'plane', 'true', 'false'), ('478', 'planet', 'true', 'false'), ('479', 'plant', 'true', 'false'), ('480', 'plateau', 'true', 'false'), ('481', 'pond', 'true', 'false'), ('482', 'prize', 'true', 'false'), ('483', 'rabbit', 'true', 'false'), ('484', 'rain', 'true', 'false'), ('485', 'range', 'true', 'false'), ('486', 'reef', 'true', 'false'), ('487', 'reserve', 'true', 'false'), ('488', 'resonance', 'true', 'false'), ('489', 'river', 'true', 'false'), ('490', 'rock', 'true', 'false'), ('491', 'sage', 'true', 'false'), ('492', 'salute', 'true', 'false'), ('493', 'sanctuary', 'true', 'false'), ('494', 'sand', 'true', 'false'), ('495', 'sands', 'true', 'false'), ('496', 'shark', 'true', 'false'), ('497', 'shelter', 'true', 'false'), ('498', 'shirt', 'true', 'false'), ('499', 'shoe', 'true', 'false'), ('500', 'silence', 'true', 'false'), ('501', 'sky', 'true', 'false'), ('502', 'smokescreen', 'true', 'false'), ('503', 'snowflake', 'true', 'false'), ('504', 'socks', 'true', 'false'), ('505', 'soil', 'true', 'false'), ('506', 'soul', 'true', 'false'), ('507', 'soup', 'true', 'false'), ('508', 'sparrow', 'true', 'false'), ('509', 'spoon', 'true', 'false'), ('510', 'spring', 'true', 'false'), ('511', 'star', 'true', 'false'), ('512', 'stone', 'true', 'false'), ('513', 'storm', 'true', 'false'), ('514', 'stream', 'true', 'false'), ('515', 'summer', 'true', 'false'), ('516', 'summit', 'true', 'false'), ('517', 'sun', 'true', 'false'), ('518', 'sunrise', 'true', 'false'), ('519', 'sunset', 'true', 'false'), ('520', 'sunshine', 'true', 'false'), ('521', 'surf', 'true', 'false'), ('522', 'swamp', 'true', 'false'), ('523', 'table', 'true', 'false'), ('524', 'teacher', 'true', 'false'), ('525', 'temple', 'true', 'false'), ('526', 'thorns', 'true', 'false'), ('527', 'tiger', 'true', 'false'), ('528', 'tigers', 'true', 'false'), ('529', 'towel', 'true', 'false'), ('530', 'train', 'true', 'false'), ('531', 'tree', 'true', 'false'), ('532', 'truck', 'true', 'false'), ('533', 'tsunami', 'true', 'false'), ('534', 'tundra', 'true', 'false'), ('535', 'valley', 'true', 'false'), ('536', 'volcano', 'true', 'false'), ('537', 'water', 'true', 'false'), ('538', 'waterfall', 'true', 'false'), ('539', 'waves', 'true', 'false'), ('540', 'wild', 'true', 'false'), ('541', 'willow', 'true', 'false'), ('542', 'window', 'true', 'false'), ('543', 'winds', 'true', 'false'), ('544', 'winter', 'true', 'false'), ('545', 'zebra', 'true', 'false');



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
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'test2@pawtograder.com', 'dummyhash', NOW(), '{}', '{}', FALSE);

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
  
END $$;

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
(demo_class_id, java_deck_id, 'Java Variables', 'What keyword is used to declare a variable that cannot be changed?', '`final`'),
(demo_class_id, java_deck_id, 'Java Methods', 'What is the entry point for a Java application?', 'The `main` method: `public static void main(String[] args)`'),
(demo_class_id, java_deck_id, 'Object-Oriented Programming', 'What are the four main principles of OOP?', 'Encapsulation, Abstraction, Inheritance, and Polymorphism');

END $$;
