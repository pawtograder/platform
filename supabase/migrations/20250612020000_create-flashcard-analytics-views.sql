-- Create aggregated flash-card analytics views so that the
-- frontend never needs to fetch the (potentially very large)
-- raw interaction & progress tables.
-- Each view is created with security_invoker so that RLS
-- continues to apply correctly.

-- -----------------------------------------------------------------
-- View: flashcard_student_deck_analytics
-- One row per (class_id, deck_id, student_profile_id)
-- -----------------------------------------------------------------
DROP VIEW IF EXISTS public.flashcard_student_deck_analytics;

CREATE OR REPLACE VIEW public.flashcard_student_deck_analytics
WITH (security_invoker = TRUE) AS
WITH progress_agg AS (
    SELECT
        sfdp.class_id,
        f.deck_id,
        sfdp.student_id          AS student_profile_id,
        COUNT(*)                                                AS total_cards,
        COUNT(*) FILTER (WHERE sfdp.is_mastered)                AS mastered_count
    FROM public.student_flashcard_deck_progress AS sfdp
    JOIN public.flashcards                       AS f  ON f.id = sfdp.card_id
    GROUP BY sfdp.class_id, f.deck_id, sfdp.student_id
),
interaction_agg AS (
    SELECT
        fil.class_id,
        fil.deck_id,
        fil.student_id          AS student_profile_id,
        COUNT(*) FILTER (WHERE fil.action = 'card_prompt_viewed')        AS prompt_views,
        COUNT(*) FILTER (WHERE fil.action = 'card_answer_viewed')        AS answer_views,
        COUNT(*) FILTER (WHERE fil.action = 'card_returned_to_deck')     AS returned_to_deck
    FROM public.flashcard_interaction_logs AS fil
    GROUP BY fil.class_id, fil.deck_id, fil.student_id
),
private_names AS (
    SELECT ur.user_id, ur.class_id, pr.name
    FROM public.user_roles ur
    JOIN public.profiles pr ON pr.id = ur.private_profile_id
)
SELECT
    COALESCE(p.student_profile_id, i.student_profile_id) AS student_profile_id,
    COALESCE(p.class_id, i.class_id)                     AS class_id,
    COALESCE(p.deck_id,  i.deck_id)                      AS deck_id,
    COALESCE(pn.name, 'User ' || LEFT(COALESCE(p.student_profile_id, i.student_profile_id)::text, 8)) AS name,
    COALESCE(p.mastered_count, 0)                        AS mastered_count,
    COALESCE(p.total_cards, 0) - COALESCE(p.mastered_count, 0) AS not_mastered_count,
    COALESCE(i.prompt_views, 0)                          AS prompt_views,
    COALESCE(i.answer_views, 0)                          AS answer_views,
    COALESCE(i.returned_to_deck, 0)                      AS returned_to_deck
FROM progress_agg p
FULL JOIN interaction_agg               AS i
       ON p.class_id = i.class_id
      AND p.deck_id  = i.deck_id
      AND p.student_profile_id = i.student_profile_id
LEFT JOIN private_names          AS pn
       ON pn.user_id = COALESCE(p.student_profile_id, i.student_profile_id)
      AND pn.class_id = COALESCE(p.class_id, i.class_id)
LEFT JOIN public.profiles               AS pr
       ON false;

-- -----------------------------------------------------------------
-- View: flashcard_deck_analytics
-- One row per (class_id, deck_id)
-- -----------------------------------------------------------------
DROP VIEW IF EXISTS public.flashcard_deck_analytics;

CREATE OR REPLACE VIEW public.flashcard_deck_analytics
WITH (security_invoker = TRUE) AS
SELECT
    fd.class_id,
    fd.id                  AS deck_id,
    fd.name                AS deck_name,
    COUNT(fil.*) FILTER (WHERE fil.action = 'deck_viewed')                 AS views,
    COUNT(fil.*) FILTER (WHERE fil.action = 'deck_progress_reset_all')     AS resets
FROM public.flashcard_decks            AS fd
LEFT JOIN public.flashcard_interaction_logs AS fil
       ON fil.deck_id = fd.id AND fil.class_id = fd.class_id
GROUP BY fd.class_id, fd.id, fd.name;

-- -----------------------------------------------------------------
-- View: flashcard_student_card_analytics
-- One row per (class_id, deck_id, card_id, student_profile_id)
-- -----------------------------------------------------------------
DROP VIEW IF EXISTS public.flashcard_student_card_analytics;

CREATE OR REPLACE VIEW public.flashcard_student_card_analytics
WITH (security_invoker = TRUE) AS
WITH private_names AS (
    SELECT ur.user_id, ur.class_id, pr.name
    FROM public.user_roles ur
    JOIN public.profiles pr ON pr.id = ur.private_profile_id
)
SELECT
    fil.class_id,
    fil.deck_id,
    fil.card_id,
    fil.student_id          AS student_profile_id,
    pn.name                 AS student_name,

    COUNT(*) FILTER (WHERE fil.action = 'card_prompt_viewed')            AS prompt_views,
    COUNT(*) FILTER (WHERE fil.action = 'card_answer_viewed')            AS answer_views,
    COUNT(*) FILTER (WHERE fil.action = 'card_marked_got_it')            AS got_it_count,
    COUNT(*) FILTER (WHERE fil.action = 'card_marked_keep_trying')       AS keep_trying_count,
    COUNT(*) FILTER (WHERE fil.action = 'card_returned_to_deck')         AS returned_to_deck,

    AVG(CASE WHEN fil.action = 'card_answer_viewed'        THEN fil.duration_on_card_ms END) AS avg_answer_time_ms,
    AVG(CASE WHEN fil.action = 'card_marked_got_it'        THEN fil.duration_on_card_ms END) AS avg_got_it_time_ms,
    AVG(CASE WHEN fil.action = 'card_marked_keep_trying'   THEN fil.duration_on_card_ms END) AS avg_keep_trying_time_ms
FROM public.flashcard_interaction_logs AS fil
LEFT JOIN private_names pn ON pn.user_id = fil.student_id AND pn.class_id = fil.class_id
GROUP BY fil.class_id, fil.deck_id, fil.card_id, fil.student_id, pn.name;

-- -----------------------------------------------------------------
-- View: flashcard_card_analytics
-- One row per (class_id, deck_id, card_id)
-- -----------------------------------------------------------------
DROP VIEW IF EXISTS public.flashcard_card_analytics;

CREATE OR REPLACE VIEW public.flashcard_card_analytics
WITH (security_invoker = TRUE) AS
SELECT
    fil.class_id,
    fil.deck_id,
    fil.card_id,

    COUNT(*) FILTER (WHERE fil.action = 'card_prompt_viewed')            AS prompt_views,
    COUNT(*) FILTER (WHERE fil.action = 'card_returned_to_deck')         AS returned_to_deck,

    -- Total / count aggregates for answer/got_it/keep_trying durations
    AVG(CASE WHEN fil.action = 'card_answer_viewed'      THEN fil.duration_on_card_ms END)    AS avg_answer_time_ms,
    COUNT(*) FILTER (WHERE fil.action = 'card_answer_viewed')            AS answer_viewed_count,

    AVG(CASE WHEN fil.action = 'card_marked_got_it'      THEN fil.duration_on_card_ms END)    AS avg_got_it_time_ms,
    COUNT(*) FILTER (WHERE fil.action = 'card_marked_got_it')            AS got_it_count,

    AVG(CASE WHEN fil.action = 'card_marked_keep_trying' THEN fil.duration_on_card_ms END)    AS avg_keep_trying_time_ms,
    COUNT(*) FILTER (WHERE fil.action = 'card_marked_keep_trying')       AS keep_trying_count
FROM public.flashcard_interaction_logs AS fil
GROUP BY fil.class_id, fil.deck_id, fil.card_id;

-- Add comments for clarity ---------------------------------------------------
COMMENT ON VIEW public.flashcard_student_deck_analytics IS
'Aggregated flash-card metrics per student & deck (one row per student).';

COMMENT ON VIEW public.flashcard_deck_analytics IS
'Aggregated flash-card metrics per deck for instructor dashboards.';

COMMENT ON VIEW public.flashcard_student_card_analytics IS
'Aggregated flash-card metrics per student & card within a deck.';

COMMENT ON VIEW public.flashcard_card_analytics IS
'Aggregated flash-card metrics per card (across all students) for instructor dashboards.'; 